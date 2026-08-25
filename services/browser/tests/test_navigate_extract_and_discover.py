"""End-to-end tests for the `browser.navigate_extract_and_discover` tool
(P03-F05): composes one real navigation with network capture, endpoint-map
inference/conservative auto-activation, content extraction, and closed
action-affordance correlation -- against real headless Chrome and this
project's own local fixture HTTP server (never the public internet).

Every test gets its own fresh, disposable browser, endpoint-map repository,
and discovered-API invoker (mirroring `test_navigate_and_extract.py`'s
one-fresh-browser-per-test policy and `test_discovered_api_invoker.py`'s
`configure_discovered_api_invoker` test-injection pattern) so tests never
see each other's discovered state, even though every test in this file
happens to derive the identical `site_id` from "127.0.0.1" (the fixture
server always binds loopback).

`resolver=_fake_public_resolver` is injected into the `DiscoveryService`
(and, for tests that reach the auto-activated operation's tool
definition, the `DiscoveredApiInvoker`) for every test except the one
proving the real SSRF/network-policy check: navigation itself still goes
to the real local fixture server regardless of what this Python-side
resolver reports (Chrome resolves the URL's hostname on its own), so this
only bypasses `DiscoveryService`/`DiscoveredApiInvoker`'s own
private-address check for testing purposes -- it never weakens what
actually gets requested.
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
from browser_service.contracts import InvocationNavigateExtractAndDiscover
from browser_service.discovered_api.invoker import DiscoveredApiInvoker
from browser_service.discovery import DiscoveryService
from browser_service.endpoint_map.repository import InMemoryEndpointMapRepository
from browser_service.sites.loader import SitePolicyLoader
from browser_service.tool_outcome import ToolExecutionError
from browser_service.tools.invoke_discovered_api import configure_discovered_api_invoker
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
        "browser_service_fixture_http_server_discover_e2e", path
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


def make_invocation(url: str, tool_call_id: str = "call-discover-1") -> dict[str, object]:
    return {
        "contractVersion": 1,
        "correlation": {
            "requestId": "req-discover-1",
            "userId": "user-discover-1",
            "sessionId": "sess-discover-1",
            "taskId": "task-discover-1",
        },
        "toolCallId": tool_call_id,
        "toolName": "browser.navigate_extract_and_discover",
        "arguments": {"url": url},
    }


def test_discovers_activates_and_correlates_action_affordances(http_port: int) -> None:
    async def run() -> None:
        repository = InMemoryEndpointMapRepository()
        policies = SitePolicyLoader(root=Path("does-not-exist"))
        discovery_service = DiscoveryService(
            repository, policies, resolver=_fake_public_resolver, settle_seconds=0.2
        )
        client = httpx.AsyncClient(follow_redirects=False)
        configure_discovered_api_invoker(
            DiscoveredApiInvoker(repository, policies, client, resolver=_fake_public_resolver)
        )

        invocation = InvocationNavigateExtractAndDiscover.model_validate(
            make_invocation(f"{base_url(http_port)}/discovery-rich.html")
        )
        outcome = await run_navigate_extract_and_discover(
            invocation,
            asyncio.Event(),
            policy=TEST_POLICY,
            repository=repository,
            policies=policies,
            discovery_service=discovery_service,
        )

        document = outcome.payload["document"]
        discovery = outcome.payload["discovery"]

        assert document["untrusted"] is True
        affordance_labels = {a["label"] for a in document["affordances"]}
        assert {"Add to cart", "Buy now", "Read the docs", "Search"} <= affordance_labels

        # Three repeated observations of the same GET /api/products
        # operation clear the high-confidence bar, so the candidate is
        # auto-activated: activeMapVersion is populated and matches the
        # candidate, and its GET operation is exposed as a callable
        # read-only handle.
        assert discovery["observationCount"] == 3
        assert discovery["operationCount"] == 1
        assert discovery["activeMapVersion"] == discovery["candidateMapVersion"]
        assert len(discovery["operations"]) == 1
        operation = discovery["operations"][0]
        assert operation["method"] == "GET"
        assert operation["siteId"] == "127-0-0-1"

        actions_by_item = {a["itemHandle"]: a for a in discovery["actions"]}

        # BUTTON: always unknown/action_execution, regardless of evidence.
        add_to_cart = next(
            a for a in document["affordances"] if a["label"] == "Add to cart"
        )
        add_action = actions_by_item[add_to_cart["affordanceId"]]
        assert add_action["targetClass"] == "unknown"
        assert add_action["requiredCapability"] == "action_execution"
        assert add_action["intent"] == "purchase"
        assert add_action["evidence"] == [
            {"kind": "dom_affordance", "affordanceId": add_to_cart["affordanceId"]}
        ]

        # FORM: always unknown/action_execution too, with a submit_form
        # fallback intent (no field values are ever captured).
        search_form = next(a for a in document["affordances"] if a["role"] == "form")
        form_action = actions_by_item[search_form["affordanceId"]]
        assert form_action["targetClass"] == "unknown"
        assert form_action["requiredCapability"] == "action_execution"
        assert form_action["intent"] == "submit_form"

        # LINK with a mutating-intent label ("Buy now") whose destination
        # exactly matches the observed, now-active GET operation: this is
        # the one case with explicit provenance strong enough for
        # read_only_operation, and it's already invocable today (no future
        # capability required).
        buy_now = next(a for a in document["affordances"] if a["label"] == "Buy now")
        buy_action = actions_by_item[buy_now["affordanceId"]]
        assert buy_action["targetClass"] == "read_only_operation"
        assert buy_action["requiredCapability"] == "none"
        assert any(e["kind"] == "observed_operation" for e in buy_action["evidence"])

        # LINK with no mutating-intent label ("Read the docs") is never
        # turned into an action affordance -- it's just an ordinary link.
        read_the_docs_id = next(
            aff["affordanceId"]
            for aff in document["affordances"]
            if aff["label"] == "Read the docs"
        )
        assert read_the_docs_id not in actions_by_item

        # Closed shape: never a URL, selector, script, header, or cookie
        # field anywhere in an action-affordance descriptor.
        for action in discovery["actions"]:
            assert set(action.keys()) == {
                "actionId",
                "intent",
                "siteId",
                "sourceHandle",
                "listingHandle",
                "itemHandle",
                "targetClass",
                "evidence",
                "confidence",
                "requiredCapability",
            }

    asyncio.run(run())


def test_low_confidence_candidate_stays_pending(http_port: int) -> None:
    async def run() -> None:
        repository = InMemoryEndpointMapRepository()
        policies = SitePolicyLoader(root=Path("does-not-exist"))
        discovery_service = DiscoveryService(
            repository, policies, resolver=_fake_public_resolver, settle_seconds=0.2
        )
        client = httpx.AsyncClient(follow_redirects=False)
        configure_discovered_api_invoker(
            DiscoveredApiInvoker(repository, policies, client, resolver=_fake_public_resolver)
        )

        invocation = InvocationNavigateExtractAndDiscover.model_validate(
            make_invocation(f"{base_url(http_port)}/discovery-low-confidence.html")
        )
        outcome = await run_navigate_extract_and_discover(
            invocation,
            asyncio.Event(),
            policy=TEST_POLICY,
            repository=repository,
            policies=policies,
            discovery_service=discovery_service,
        )

        discovery = outcome.payload["discovery"]
        assert discovery["observationCount"] == 1
        assert discovery["operationCount"] == 1
        assert discovery["activeMapVersion"] is None
        assert discovery["operations"] == []
        assert any("auto-activation" in warning for warning in discovery["warnings"])

    asyncio.run(run())


def test_static_page_yields_empty_discovery_section(http_port: int) -> None:
    async def run() -> None:
        repository = InMemoryEndpointMapRepository()
        policies = SitePolicyLoader(root=Path("does-not-exist"))
        discovery_service = DiscoveryService(
            repository, policies, resolver=_fake_public_resolver, settle_seconds=0.1
        )
        client = httpx.AsyncClient(follow_redirects=False)
        configure_discovered_api_invoker(
            DiscoveredApiInvoker(repository, policies, client, resolver=_fake_public_resolver)
        )

        invocation = InvocationNavigateExtractAndDiscover.model_validate(
            make_invocation(f"{base_url(http_port)}/index.html")
        )
        outcome = await run_navigate_extract_and_discover(
            invocation,
            asyncio.Event(),
            policy=TEST_POLICY,
            repository=repository,
            policies=policies,
            discovery_service=discovery_service,
        )

        discovery = outcome.payload["discovery"]
        assert discovery["observationCount"] == 0
        assert discovery["operationCount"] == 0
        assert discovery["operations"] == []
        assert discovery["actions"] == []
        assert discovery["activeMapVersion"] is None

    asyncio.run(run())


def test_loopback_address_is_blocked_without_the_local_fixture_escape_hatch(
    http_port: int,
) -> None:
    """No resolver override here: the real SSRF/network-address check in
    `DiscoveryService.discover` applies, and this tool always derives an
    ordinary opaque `site_id` from the URL's hostname (never the
    special-cased `"local-fixture"` id), so a real loopback destination is
    blocked exactly as it would be for any other unlisted private/loopback
    target.
    """

    async def run() -> None:
        invocation = InvocationNavigateExtractAndDiscover.model_validate(
            make_invocation(f"{base_url(http_port)}/index.html")
        )
        with pytest.raises(ToolExecutionError) as exc_info:
            await run_navigate_extract_and_discover(
                invocation, asyncio.Event(), policy=TEST_POLICY
            )
        assert exc_info.value.code == "POLICY_BLOCKED"

    asyncio.run(run())


def test_kill_switched_site_blocks_before_capture(http_port: int, tmp_path: Path) -> None:
    async def run() -> None:
        sites_root = tmp_path / "sites"
        sites_root.mkdir()
        (sites_root / "127-0-0-1.yaml").write_text(
            """schema_version: 1
site_id: 127-0-0-1
canonical_domain: 127.0.0.1
allowed_subdomains: []
allowed_routes: [/api/*]
allowed_methods: [GET]
discovery_permitted: true
replay_permitted: true
data_classification: internal
retention_days: 1
owner: test
reviewer: human
decision: approved
decision_date: 2026-08-24
review_date: 2026-08-24
kill_switch_enabled: true
""",
            encoding="utf-8",
        )
        policies = SitePolicyLoader(root=sites_root)
        repository = InMemoryEndpointMapRepository()
        discovery_service = DiscoveryService(repository, policies, resolver=_fake_public_resolver)

        invocation = InvocationNavigateExtractAndDiscover.model_validate(
            make_invocation(f"{base_url(http_port)}/index.html")
        )
        with pytest.raises(ToolExecutionError) as exc_info:
            await run_navigate_extract_and_discover(
                invocation,
                asyncio.Event(),
                policy=TEST_POLICY,
                repository=repository,
                policies=policies,
                discovery_service=discovery_service,
            )
        assert exc_info.value.code == "POLICY_BLOCKED"

    asyncio.run(run())


def test_registered_in_tool_registry_and_bounded_arguments() -> None:
    from browser_service.tool_registry import TOOL_REGISTRY

    registration = TOOL_REGISTRY["browser.navigate_extract_and_discover"]
    fields = set(registration.invocation_model.model_fields["arguments"].annotation.model_fields)
    assert fields == {"url", "goal"}
