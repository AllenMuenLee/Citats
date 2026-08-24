"""CDP ``Network`` domain subscription for XHR/fetch capture (P03-F01).

``capture_network`` is a standalone async context manager, independent of
``browser.navigation``'s ``Fetch``-domain interception -- both CDP domains
can be enabled on the same page/tab simultaneously without coordination.
Callers wrap their own navigation call (e.g.
``NavigationService.navigate``/``page.get``) inside this context manager;
this module never navigates a page itself.

Raw CDP request/response state is correlated by CDP ``requestId`` in a
dict local to one ``capture_network`` call (i.e. task-local: a fresh dict
per call, never shared across tasks/sessions) and is only ever held long
enough to build one sanitized observation -- it is discarded immediately
after handing that observation to ``sink``, and the whole dict is cleared
in ``finally`` on normal completion, error, or cancellation alike, so nothing
raw survives past this context manager exiting.
"""

from __future__ import annotations

import contextlib
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass

from nodriver.cdp import network as cdp_network
from nodriver.core.tab import Tab  # type: ignore[import-untyped]

from browser_service.network.observation import SanitizedNetworkObservation
from browser_service.network.sanitizer import (
    DEFAULT_LIMITS,
    RawExchange,
    SanitizerLimits,
    normalize_origin,
    sanitize_exchange,
)

logger = logging.getLogger("browser_service.network.capture")

ObservationSink = Callable[[SanitizedNetworkObservation], Awaitable[None] | None]

# Response bodies are read in full over CDP (Network.getResponseBody has no
# partial-read mode) then sliced to this bound *before* ever being handed
# to the sanitizer or held in a RawExchange -- keeps a single oversized body
# from ballooning task-local memory even transiently.
MAX_RAW_BODY_CHARS = 1_000_000

_CAPTURED_RESOURCE_TYPES = frozenset({cdp_network.ResourceType.XHR, cdp_network.ResourceType.FETCH})


def _header_value(headers: cdp_network.Headers | None, name: str) -> str | None:
    if not headers:
        return None
    lowered = name.lower()
    for key, value in headers.items():
        if key.lower() == lowered:
            return str(value)
    return None


def _is_text_like(content_type: str | None) -> bool:
    if not content_type:
        return True
    base = content_type.split(";", 1)[0].strip().lower()
    return base.startswith(("application/json", "application/ld+json", "application/xml", "text/")) or (
        "x-www-form-urlencoded" in base
    )


@dataclass
class _Pending:
    method: str
    url: str
    resource_type: str | None
    initiator_type: str
    request_timestamp: float
    wall_time: float
    request_body_text: str | None
    request_content_type: str | None
    response: cdp_network.Response | None = None
    response_resource_type: str | None = None


async def _call_sink(sink: ObservationSink, observation: SanitizedNetworkObservation) -> None:
    result = sink(observation)
    if result is not None:
        await result


@asynccontextmanager
async def capture_network(
    page: Tab,
    *,
    task_id: str,
    session_id: str | None,
    sink: ObservationSink,
    page_origin: str | None = None,
    limits: SanitizerLimits = DEFAULT_LIMITS,
) -> AsyncIterator[None]:
    """Capture sanitized XHR/fetch observations on ``page`` for the
    duration of this context manager.

    ``page_origin``, when given, is used as the fixed same-origin baseline
    for every observation. When omitted, each finished exchange is compared
    against ``page.target.url`` at the moment it finishes (so it reflects
    whatever the page has actually navigated to by then).

    Wrap your own ``page.get(url)``/navigation call inside this context;
    this function never navigates ``page`` itself. Enable this *before*
    navigating so the initial document's own XHR/fetch traffic is not
    missed.
    """
    pending: dict[str, _Pending] = {}

    async def on_request_will_be_sent(event: cdp_network.RequestWillBeSent, tab: Tab) -> None:
        request = event.request
        pending[str(event.request_id)] = _Pending(
            method=request.method,
            url=request.url,
            resource_type=event.type_.value if event.type_ is not None else None,
            initiator_type=event.initiator.type_,
            request_timestamp=float(event.timestamp),
            wall_time=float(event.wall_time),
            request_body_text=request.post_data,
            request_content_type=_header_value(request.headers, "content-type"),
        )

    async def on_response_received(event: cdp_network.ResponseReceived, tab: Tab) -> None:
        entry = pending.get(str(event.request_id))
        if entry is None:
            return
        entry.response = event.response
        entry.response_resource_type = event.type_.value if event.type_ is not None else None

    async def on_loading_failed(event: cdp_network.LoadingFailed, tab: Tab) -> None:
        # Never partially recorded: a failed load has no usable
        # response, so it is simply dropped rather than sanitized.
        pending.pop(str(event.request_id), None)

    async def on_loading_finished(event: cdp_network.LoadingFinished, tab: Tab) -> None:
        entry = pending.pop(str(event.request_id), None)
        if entry is None or entry.response is None:
            return
        response = entry.response
        resource_type = entry.response_resource_type or entry.resource_type
        if resource_type not in {rt.value for rt in _CAPTURED_RESOURCE_TYPES}:
            return

        content_type = response.mime_type or _header_value(response.headers, "content-type")
        response_body_text: str | None = None
        if _is_text_like(content_type):
            with contextlib.suppress(Exception):
                body, is_base64 = await tab.send(cdp_network.get_response_body(event.request_id))
                if not is_base64 and body:
                    response_body_text = body[:MAX_RAW_BODY_CHARS]
                # is_base64 True means the body is actually binary despite
                # a text-ish content-type claim -- leave response_body_text
                # unset (None) rather than ever decoding/retaining it.

        raw = RawExchange(
            request_id=str(event.request_id),
            method=entry.method,
            url=entry.url,
            resource_type=resource_type,
            initiator_type=entry.initiator_type,
            status=response.status,
            response_content_type=content_type,
            response_header_names=tuple(response.headers.keys()) if response.headers else (),
            request_timestamp=entry.request_timestamp,
            finished_timestamp=float(event.timestamp),
            wall_time=entry.wall_time,
            request_body_text=entry.request_body_text,
            request_content_type=entry.request_content_type,
            response_body_text=response_body_text,
        )

        origin = page_origin
        if origin is None and tab.target is not None and tab.target.url:
            origin = normalize_origin(tab.target.url)

        try:
            observation = sanitize_exchange(
                raw,
                task_id=task_id,
                session_id=session_id,
                page_origin=origin,
                limits=limits,
            )
        except Exception:  # noqa: BLE001 -- capture must never crash the page's event dispatch
            logger.warning(
                "browser_service.network.sanitize_failed",
                extra={"task_id": task_id, "resource_type": resource_type},
                exc_info=True,
            )
            return

        if observation is not None:
            await _call_sink(sink, observation)

    page.add_handler(cdp_network.RequestWillBeSent, on_request_will_be_sent)
    page.add_handler(cdp_network.ResponseReceived, on_response_received)
    page.add_handler(cdp_network.LoadingFinished, on_loading_finished)
    page.add_handler(cdp_network.LoadingFailed, on_loading_failed)
    try:
        await page.send(cdp_network.enable())
        yield
    finally:
        page.remove_handler(cdp_network.RequestWillBeSent, on_request_will_be_sent)
        page.remove_handler(cdp_network.ResponseReceived, on_response_received)
        page.remove_handler(cdp_network.LoadingFinished, on_loading_finished)
        page.remove_handler(cdp_network.LoadingFailed, on_loading_failed)
        with contextlib.suppress(Exception):
            await page.send(cdp_network.disable())
        pending.clear()


__all__ = ["ObservationSink", "capture_network"]
