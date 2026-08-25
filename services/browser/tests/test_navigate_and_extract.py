"""End-to-end tests for the `browser.navigate_and_extract` tool (P02-F04).

Exercises the full composition -- URL policy, browser lifecycle,
navigation, and extraction -- against real headless Chrome and this
project's own local fixture HTTP server (never the public internet), for
each scenario called out by the phase's validation requirements: a
static page, a client-rendered page, a redirected page, a malformed
page, an oversized page, a blocked target, a malicious (hidden
prompt-injection/credential-shaped) page, and an interaction-rich page
(links, buttons, a form, and post-render ARIA state) whose affordance
metadata must stay descriptive-only. `test_navigate_and_extract_via_http_bridge`
additionally proves the whole `/v1/tools/invoke` HTTP round trip works
for this tool, not just the internal composition function.

Direct-call tests pass `policy=UrlPolicy(test_only_allowed_hosts=...)`
into `run_navigate_and_extract` (a test-only injection point that
`tool_registry.TOOL_REGISTRY` itself never uses -- see that function's
docstring) so navigation can reach the local fixture server despite the
loopback-blocking rule that (correctly) applies in production. The
"via HTTP bridge" success test instead temporarily monkeypatches the
*registered* handler to inject the same test policy, so it still
exercises the real `/v1/tools/invoke` dispatch/envelope/validation path
end-to-end rather than bypassing it.

Every test uses its own fresh, disposable browser/event loop (see
`test_browser_navigation.py`'s module docstring for why: sharing one
real-Chrome browser/event loop across many navigations that abort an
in-flight request can trigger an unrelated nodriver/`websockets`
concurrency bug on this host).
"""

from __future__ import annotations

import asyncio
import dataclasses
import importlib.util
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType

import pytest
from fastapi.testclient import TestClient

import browser_service.tools._lifecycle as lifecycle_module
from browser_service.app import app
from browser_service.browser import BrowserLifecycleManager, NavigationService, UrlPolicy
from browser_service.contracts import InvocationNavigateAndExtract
from browser_service.extraction import AffordanceRole, extract_document
from browser_service.tool_outcome import ToolExecutionError, ToolHandlerOutcome
from browser_service.tool_registry import TOOL_REGISTRY
from browser_service.tools.navigate_and_extract import run_navigate_and_extract

TEST_POLICY = UrlPolicy(test_only_allowed_hosts=frozenset({"127.0.0.1"}))


@pytest.fixture(autouse=True)
def _reset_lifecycle_manager_between_tests() -> Iterator[None]:
    """The one process-wide browser-lifecycle manager every browser-driving
    tool shares (`browser_service.tools._lifecycle`) is a lazily-created
    singleton bound to whatever event loop was running when it was first
    used -- correct for a long-lived production ASGI server, but every test
    in this file runs its own fresh `asyncio.run()` (see the module
    docstring for why). Without resetting the singleton, the second test to
    touch it would try to drive a browser bound to an already-closed event
    loop. Reset (and cleanly shut down the previous browser, if any) after
    every test so each one gets its own.
    """
    yield
    manager = lifecycle_module._lifecycle_manager
    lifecycle_module._lifecycle_manager = None
    if manager is not None:
        asyncio.run(manager.shutdown())


def _load_fixture_server_module() -> ModuleType:
    path = Path(__file__).parent / "fixtures" / "http" / "server.py"
    spec = importlib.util.spec_from_file_location("browser_service_fixture_http_server_e2e", path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_fixture_server_module = _load_fixture_server_module()
fixture_http_server = _fixture_server_module.fixture_http_server


@pytest.fixture
def http_port() -> Iterator[int]:
    # Function-scoped (not shared) -- each test's fixture server instance
    # is independent, matching this file's one-fresh-browser-per-test
    # policy.
    with fixture_http_server() as port:
        yield port


def base_url(port: int) -> str:
    return f"http://127.0.0.1:{port}"


def make_invocation(url: str, tool_call_id: str = "call-e2e-1") -> dict[str, object]:
    return {
        "contractVersion": 1,
        "correlation": {"requestId": "req-e2e-1", "userId": "user-e2e-1"},
        "toolCallId": tool_call_id,
        "toolName": "browser.navigate_and_extract",
        "arguments": {"url": url},
    }


def test_static_page_returns_bounded_chunks_metadata_and_evidence(http_port: int) -> None:
    async def run() -> None:
        invocation = InvocationNavigateAndExtract.model_validate(
            make_invocation(f"{base_url(http_port)}/article.html")
        )
        outcome = await run_navigate_and_extract(invocation, asyncio.Event(), policy=TEST_POLICY)

        assert outcome.payload["metadata"]["title"] == "What is an AI-native browser?"
        assert outcome.payload["metadata"]["language"] == "en"
        assert outcome.payload["metadata"]["publishedTime"] == "2026-08-01T09:00:00+00:00"
        assert len(outcome.payload["chunks"]) >= 1
        joined = " ".join(chunk["text"] for chunk in outcome.payload["chunks"])
        assert "AI-native browser lets a model drive real navigation" in joined
        assert outcome.payload["untrusted"] is True
        assert outcome.payload["timing"]["totalMs"] >= 0

        assert outcome.evidence
        assert all(item["sourceUrl"].endswith("/article.html") for item in outcome.evidence)

    asyncio.run(run())


def test_client_rendered_page_captures_post_render_content(http_port: int) -> None:
    async def run() -> None:
        invocation = InvocationNavigateAndExtract.model_validate(
            make_invocation(f"{base_url(http_port)}/client-rendered.html")
        )
        outcome = await run_navigate_and_extract(invocation, asyncio.Event(), policy=TEST_POLICY)
        joined = " ".join(chunk["text"] for chunk in outcome.payload["chunks"])
        assert "Rendered by client script" in joined
        assert "This paragraph only exists after JavaScript runs" in joined

    asyncio.run(run())


def test_redirected_page_extracts_from_final_url(http_port: int) -> None:
    async def run() -> None:
        target = f"{base_url(http_port)}/article.html"
        redirect = f"{base_url(http_port)}/redirect?to={target}"
        invocation = InvocationNavigateAndExtract.model_validate(make_invocation(redirect))
        outcome = await run_navigate_and_extract(invocation, asyncio.Event(), policy=TEST_POLICY)
        assert outcome.payload["metadata"]["url"].endswith("/article.html")
        joined = " ".join(chunk["text"] for chunk in outcome.payload["chunks"])
        assert "AI-native browser" in joined

    asyncio.run(run())


def test_malformed_html_extracts_without_crashing(http_port: int) -> None:
    async def run() -> None:
        invocation = InvocationNavigateAndExtract.model_validate(
            make_invocation(f"{base_url(http_port)}/malformed.html")
        )
        outcome = await run_navigate_and_extract(invocation, asyncio.Event(), policy=TEST_POLICY)
        joined = " ".join(chunk["text"] for chunk in outcome.payload["chunks"])
        assert "First paragraph is never closed" in joined
        assert "Second paragraph" in joined

    asyncio.run(run())


def test_oversized_page_is_truncated_with_explicit_warnings(http_port: int) -> None:
    async def run() -> None:
        invocation = InvocationNavigateAndExtract.model_validate(
            make_invocation(f"{base_url(http_port)}/oversized-content.html")
        )
        outcome = await run_navigate_and_extract(invocation, asyncio.Event(), policy=TEST_POLICY)
        codes = {warning["code"] for warning in outcome.payload["warnings"]}
        assert "document_truncated" in codes
        assert len(outcome.payload["chunks"]) <= 50
        # Evidence stays bounded too, independent of chunk count.
        assert len(outcome.evidence or []) <= 20

    asyncio.run(run())


def test_blocked_target_raises_invalid_arguments(http_port: int) -> None:
    async def run() -> None:
        # Deliberately no TEST_POLICY override here -- proves the
        # *production* policy (no allowlisted hosts) still rejects a
        # private-range target even when called through this same
        # composition function.
        invocation = InvocationNavigateAndExtract.model_validate(
            make_invocation("http://10.1.2.3/private-target")
        )
        with pytest.raises(ToolExecutionError) as excinfo:
            await run_navigate_and_extract(invocation, asyncio.Event())
        assert excinfo.value.code == "INVALID_ARGUMENTS"
        assert excinfo.value.retryable is False

    asyncio.run(run())


def test_malicious_page_flags_hidden_content_without_leaking_it(http_port: int) -> None:
    async def run() -> None:
        invocation = InvocationNavigateAndExtract.model_validate(
            make_invocation(f"{base_url(http_port)}/malicious.html")
        )
        outcome = await run_navigate_and_extract(invocation, asyncio.Event(), policy=TEST_POLICY)

        codes = {warning["code"] for warning in outcome.payload["warnings"]}
        assert "prompt_injection_suspected" in codes
        assert "credential_like_content" in codes

        joined = " ".join(chunk["text"] for chunk in outcome.payload["chunks"])
        assert "Ignore previous instructions" not in joined
        assert "sk_live_51H8xJ2eZvKYlo2CTAB1234567890" not in joined
        assert "miso soup" in joined
        assert outcome.payload["untrusted"] is True

    asyncio.run(run())


def test_interaction_rich_page_yields_descriptive_only_affordances(http_port: int) -> None:
    """P02-F04 step 5: an "interaction-rich" page, navigated for real
    against this project's own fixture server, must yield affordances that
    are descriptive only (post-render role/label/safe-destination/disabled,
    never a selector/script/field value) -- and there must be no tool
    anywhere in the registry that could take an affordance's opaque ID and
    turn it into a click/fill/submit. Composes navigation + extraction the
    same way `run_navigate_and_extract` does, but keeps the full
    `ExtractedDocument` (rather than its trimmed wire payload) so
    `affordances` -- which the tool's payload never surfaces to Mistral --
    is directly inspectable here.
    """

    async def run() -> None:
        manager = BrowserLifecycleManager()
        navigation_service = NavigationService(TEST_POLICY)
        try:
            async with manager.isolated_context() as context:
                page = await context.open_page()
                navigate_result = await navigation_service.navigate(
                    page, f"{base_url(http_port)}/interaction-rich.html"
                )
                content_result = await navigation_service.get_content(page)
            document = extract_document(content_result.content or "", navigate_result.final_url)
        finally:
            await manager.shutdown()

        by_label = {a.label: a for a in document.affordances}

        # Rendered post-JS, not just the static markup -- proves this
        # reads the post-render DOM, matching the extraction pipeline's
        # documented content-extraction behavior.
        checkout = by_label["Checkout (sold out)"]
        assert checkout.role is AffordanceRole.BUTTON
        assert checkout.disabled is True
        assert checkout.destination is None

        # Visible text ("+") wins over aria-label ("Add to cart") for the
        # label -- the label describes what a sighted user actually sees.
        add_to_cart = by_label["+"]
        assert add_to_cart.role is AffordanceRole.BUTTON

        docs_link = by_label["Read the docs"]
        assert docs_link.role is AffordanceRole.LINK
        assert docs_link.destination == f"{base_url(http_port)}/docs"

        form_affordances = [a for a in document.affordances if a.role is AffordanceRole.FORM]
        assert [a.label for a in form_affordances] == ["Search the catalog"]
        assert form_affordances[0].destination is None
        assert form_affordances[0].disabled is False

        # Every affordance is one of exactly four descriptive fields plus
        # its opaque ID -- Pydantic's `extra="forbid"` already enforces
        # this at the type level; re-assert it here as an explicit,
        # human-readable proof.
        for affordance in document.affordances:
            assert set(affordance.model_dump().keys()) == {
                "affordance_id",
                "role",
                "label",
                "destination",
                "disabled",
            }

        dumped = str([a.model_dump() for a in document.affordances])
        assert "do-not-leak-this-value" not in dumped
        assert "<button" not in dumped
        assert "querySelector" not in dumped

        # Structural proof that no tool anywhere can turn one of these IDs
        # into an actual interaction: the registry is closed, and the
        # browsing tool's arguments accept nothing an affordance ID could
        # be smuggled into (a URL only).
        assert set(TOOL_REGISTRY) == {
            "system.echo",
            "browser.navigate_and_extract",
            "browser.explore_website",
            "browser.get_page_understanding_slice",
            "ui.propose_generative_ui_plan",
        }
        navigate_fields = set(
            TOOL_REGISTRY["browser.navigate_and_extract"].invocation_model.model_fields["arguments"].annotation.model_fields
        )
        assert navigate_fields == {"url"}

    asyncio.run(run())


def test_navigate_and_extract_via_http_bridge(
    http_port: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def policy_injecting_handler(
        invocation: InvocationNavigateAndExtract, cancelled: asyncio.Event
    ) -> ToolHandlerOutcome:
        return await run_navigate_and_extract(invocation, cancelled, policy=TEST_POLICY)

    original = TOOL_REGISTRY["browser.navigate_and_extract"]
    monkeypatch.setitem(
        TOOL_REGISTRY,
        "browser.navigate_and_extract",
        dataclasses.replace(original, handler=policy_injecting_handler),
    )

    monkeypatch.setenv("BROWSER_SERVICE_TOKEN", "test-e2e-token")
    with TestClient(app) as client:
        response = client.post(
            "/v1/tools/invoke",
            json=make_invocation(f"{base_url(http_port)}/article.html"),
            headers={"X-Service-Token": "test-e2e-token"},
        )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "success"
    assert body["payload"]["metadata"]["title"] == "What is an AI-native browser?"
    assert body["sensitivity"] == {"sensitive": False, "confirmationRequired": False}
    assert body["evidence"]


def test_navigate_and_extract_via_http_bridge_rejects_blocked_target(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BROWSER_SERVICE_TOKEN", "test-e2e-token")
    with TestClient(app) as client:
        response = client.post(
            "/v1/tools/invoke",
            json=make_invocation("http://169.254.169.254/latest/meta-data/"),
            headers={"X-Service-Token": "test-e2e-token"},
        )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "error"
    assert body["errorCode"] == "INVALID_ARGUMENTS"
