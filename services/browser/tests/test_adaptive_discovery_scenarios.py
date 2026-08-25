"""Adaptive multi-site discovery scenarios (P03-F05 step 10): proves the
`browser.navigate_extract_and_discover` -> `browser.invoke_discovered_api`
pipeline generalizes across unrelated site shapes -- accommodation search,
retail/product comparison, a travel schedule, and a completely unfamiliar
generic-record site -- using the exact same, non-hardcoded inference and
classification code path for every one of them.

Each scenario: navigate+discover a page whose on-load script repeats one
GET call three times (clearing the high-confidence auto-activation bar,
matching `test_navigate_extract_and_discover.py`'s established pattern),
then replay the newly-active operation through `browser.invoke_discovered_api`
to prove the whole source-to-structured-record flow actually works, not
just that a map got inferred.
"""

from __future__ import annotations

import asyncio
import importlib.util
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType

import httpx
import pytest

import browser_service.tools._lifecycle as lifecycle_module
from browser_service.browser import UrlPolicy
from browser_service.contracts import (
    InvocationInvokeDiscoveredApi,
    InvocationNavigateExtractAndDiscover,
)
from browser_service.discovered_api.invoker import DiscoveredApiInvoker
from browser_service.discovery import DiscoveryService
from browser_service.endpoint_map.repository import InMemoryEndpointMapRepository
from browser_service.sites.loader import SitePolicyLoader
from browser_service.tools.invoke_discovered_api import (
    configure_discovered_api_invoker,
    run_invoke_discovered_api,
)
from browser_service.tools.navigate_extract_and_discover import run_navigate_extract_and_discover

TEST_POLICY = UrlPolicy(test_only_allowed_hosts=frozenset({"127.0.0.1"}))


async def _fake_public_resolver(_hostname: str) -> tuple[str, ...]:
    return ("93.184.216.34",)


@pytest.fixture(autouse=True)
def _reset_shared_singletons_between_tests() -> Iterator[None]:
    yield
    manager = lifecycle_module._lifecycle_manager
    lifecycle_module._lifecycle_manager = None
    if manager is not None:
        asyncio.run(manager.shutdown())
    configure_discovered_api_invoker(None)


def _load_fixture_server_module() -> ModuleType:
    path = Path(__file__).parent / "fixtures" / "http" / "server.py"
    spec = importlib.util.spec_from_file_location(
        "browser_service_fixture_http_server_scenarios_e2e", path
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_fixture_server_module = _load_fixture_server_module()
fixture_http_server = _fixture_server_module.fixture_http_server


@pytest.fixture
def http_port() -> Iterator[int]:
    with fixture_http_server() as port:
        yield port


def base_url(port: int) -> str:
    return f"http://127.0.0.1:{port}"


def _discover_invocation(url: str) -> dict[str, object]:
    return {
        "contractVersion": 1,
        "correlation": {
            "requestId": "req-scenario-1",
            "userId": "user-scenario-1",
            "sessionId": "sess-scenario-1",
            "taskId": "task-scenario-1",
        },
        "toolCallId": "call-scenario-discover",
        "toolName": "browser.navigate_extract_and_discover",
        "arguments": {"url": url},
    }


def _invoke_invocation(site_id: str, operation_id: str) -> dict[str, object]:
    return {
        "contractVersion": 1,
        "correlation": {
            "requestId": "req-scenario-1",
            "userId": "user-scenario-1",
        },
        "toolCallId": "call-scenario-invoke",
        "toolName": "browser.invoke_discovered_api",
        "arguments": {"siteId": site_id, "operationId": operation_id, "parameters": {}},
    }


async def _run_scenario(
    http_port: int, page: str, *, expected_result_kind: str
) -> tuple[dict[str, object], dict[str, object]]:
    repository = InMemoryEndpointMapRepository()
    policies = SitePolicyLoader(root=Path("does-not-exist"))
    discovery_service = DiscoveryService(
        repository, policies, resolver=_fake_public_resolver, settle_seconds=0.2
    )
    client = httpx.AsyncClient(follow_redirects=False)
    configure_discovered_api_invoker(
        DiscoveredApiInvoker(repository, policies, client, resolver=_fake_public_resolver)
    )

    discover_invocation = InvocationNavigateExtractAndDiscover.model_validate(
        _discover_invocation(f"{base_url(http_port)}/{page}")
    )
    discover_outcome = await run_navigate_extract_and_discover(
        discover_invocation,
        asyncio.Event(),
        policy=TEST_POLICY,
        repository=repository,
        policies=policies,
        discovery_service=discovery_service,
    )
    discovery = discover_outcome.payload["discovery"]
    assert discovery["activeMapVersion"] == discovery["candidateMapVersion"]
    assert len(discovery["operations"]) == 1
    operation = discovery["operations"][0]
    # NOT asserted here: `operation["resultKind"]` (the discovery-time
    # classification). A known limitation -- headless Chrome's
    # `Network.getResponseBody` frequently can't retrieve a real response
    # body (see `network/capture.py`'s `on_loading_finished` docstring and
    # `discovered_api.invoker._shape_matches`) -- means the *inferred*
    # response shape is unreliable today, so this always comes back
    # "generic_records" regardless of the real endpoint shape. The
    # meaningful, real check is `invoked["resultKind"]` below, which each
    # scenario asserts against `expected_result_kind`: that value is
    # (re)classified fresh from the actual live response at invoke time,
    # not from the (currently unreliable) inferred shape.

    invoke_invocation = InvocationInvokeDiscoveredApi.model_validate(
        _invoke_invocation(operation["siteId"], operation["operationId"])
    )
    invoke_outcome = await run_invoke_discovered_api(invoke_invocation, asyncio.Event())
    assert invoke_outcome.payload["resultKind"] == expected_result_kind
    return discover_outcome.payload, invoke_outcome.payload


def test_accommodation_search_scenario(http_port: int) -> None:
    async def run() -> None:
        document, invoked = await _run_scenario(
            http_port, "discovery-accommodation.html", expected_result_kind="product_results"
        )
        assert invoked["resultKind"] == "product_results"
        assert invoked["records"][0]["name"] == "Deluxe Room"
        # "Book now" (mutating-intent + destination matching the observed
        # operation) is correlated as read_only_operation/already-actionable
        # today; "Cancellation policy" (no mutating-intent match) is not
        # elevated to an action affordance at all.
        actions_by_intent = {a["intent"]: a for a in document["discovery"]["actions"]}
        assert actions_by_intent["reserve"]["targetClass"] == "read_only_operation"
        assert actions_by_intent["reserve"]["requiredCapability"] == "none"

    asyncio.run(run())


def test_retail_comparison_scenario(http_port: int) -> None:
    async def run() -> None:
        document, invoked = await _run_scenario(
            http_port, "discovery-rich.html", expected_result_kind="product_results"
        )
        assert invoked["records"][0]["name"] == "Fixture headphones"
        assert document["discovery"]["observationCount"] == 3

    asyncio.run(run())


def test_travel_schedule_scenario(http_port: int) -> None:
    async def run() -> None:
        document, invoked = await _run_scenario(
            http_port, "discovery-flights.html", expected_result_kind="flight_comparison"
        )
        assert invoked["records"][0]["destination"] == "JFK"
        actions_by_intent = {a["intent"]: a for a in document["discovery"]["actions"]}
        assert actions_by_intent["reserve"]["targetClass"] == "read_only_operation"

    asyncio.run(run())


def test_unfamiliar_generic_record_site_scenario(http_port: int) -> None:
    async def run() -> None:
        document, invoked = await _run_scenario(
            http_port, "discovery-generic.html", expected_result_kind="generic_records"
        )
        # An unrecognized shape still falls back to generic bounded
        # records rather than failing or guessing a domain-specific shape.
        assert invoked["records"][0]["id"] == "rec-1"
        assert invoked["records"][0]["kind"] == "widget"

        # "Delete record" is a real mutating-intent link with a matching
        # observed operation -- proof that even a destructive-sounding
        # label never becomes anything more than an informational,
        # already-invocable-as-read-only-only action descriptor; nothing
        # about this result lets the model actually delete anything.
        delete_actions = [
            a for a in document["discovery"]["actions"] if a["intent"] == "delete"
        ]
        assert delete_actions
        assert delete_actions[0]["targetClass"] == "read_only_operation"
        assert delete_actions[0]["requiredCapability"] == "none"

    asyncio.run(run())
