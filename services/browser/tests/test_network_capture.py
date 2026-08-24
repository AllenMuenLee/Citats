from __future__ import annotations

from collections.abc import Callable, Coroutine
from types import SimpleNamespace
from typing import Any

import pytest
from nodriver.cdp import network as cdp_network

from browser_service.network.capture import capture_network
from browser_service.network.observation import SanitizedNetworkObservation


class FakeTab:
    def __init__(self) -> None:
        self.handlers: dict[type[object], Callable[..., Coroutine[Any, Any, None]]] = {}
        self.sent: list[object] = []
        self.target = SimpleNamespace(url="https://example.test/page")

    def add_handler(self, event_type: type[object], handler: Callable[..., Any]) -> None:
        self.handlers[event_type] = handler

    def remove_handler(self, event_type: type[object], handler: Callable[..., Any]) -> None:
        assert self.handlers[event_type] is handler
        del self.handlers[event_type]

    async def send(self, command: object) -> object:
        self.sent.append(command)
        if len(self.sent) == 2:
            return ('{"id":1,"name":"widget"}', False)
        return None


def _request_event(resource_type: cdp_network.ResourceType, *, request_id: str = "1") -> Any:
    return SimpleNamespace(
        request_id=request_id,
        type_=resource_type,
        timestamp=100.0,
        wall_time=1_700_000_000.0,
        initiator=SimpleNamespace(type_="script"),
        request=SimpleNamespace(
            method="GET",
            url="https://example.test/api/widgets?page=1",
            headers={"content-type": "application/json"},
            post_data=None,
        ),
    )


@pytest.mark.asyncio
async def test_capture_enables_before_traffic_and_emits_only_sanitized_xhr() -> None:
    tab = FakeTab()
    observations: list[SanitizedNetworkObservation] = []

    async with capture_network(
        tab, task_id="task-1", session_id="session-1", sink=observations.append
    ):
        assert tab.sent
        await tab.handlers[cdp_network.RequestWillBeSent](
            _request_event(cdp_network.ResourceType.DOCUMENT, request_id="document"), tab
        )
        await tab.handlers[cdp_network.RequestWillBeSent](
            _request_event(cdp_network.ResourceType.XHR), tab
        )
        await tab.handlers[cdp_network.ResponseReceived](
            SimpleNamespace(
                request_id="1",
                type_=cdp_network.ResourceType.XHR,
                response=SimpleNamespace(
                    status=200,
                    mime_type="application/json",
                    headers={"Content-Type": "application/json", "Set-Cookie": "secret"},
                ),
            ),
            tab,
        )
        await tab.handlers[cdp_network.LoadingFinished](
            SimpleNamespace(request_id="1", timestamp=100.25), tab
        )

    assert len(observations) == 1
    observation = observations[0]
    assert observation.task_id == "task-1"
    assert observation.session_id == "session-1"
    assert observation.same_origin is True
    assert observation.path == "/api/widgets"
    assert observation.query_keys == ("page",)
    assert "set-cookie" not in observation.stable_response_headers
    assert tab.handlers == {}


@pytest.mark.asyncio
async def test_capture_removes_handlers_and_disables_network_on_error() -> None:
    tab = FakeTab()

    with pytest.raises(RuntimeError, match="navigation failed"):
        async with capture_network(
            tab, task_id="task-1", session_id=None, sink=lambda observation: None
        ):
            await tab.handlers[cdp_network.RequestWillBeSent](
                _request_event(cdp_network.ResourceType.FETCH), tab
            )
            raise RuntimeError("navigation failed")

    assert tab.handlers == {}
    assert len(tab.sent) == 2
