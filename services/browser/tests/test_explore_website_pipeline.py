"""P03-R03 validation: exploration succeeds when full HTML serialization
stalls but bounded observation is useful, total/sub-budget enforcement,
partial-success thresholds, evidence validity, TIMEOUT when no useful
evidence exists, and contract-conformant payloads.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

import pytest
from tests.fixtures.accommodation_dom import (
    CHECK_IN,
    CHECK_OUT,
    COLLECTION_URL,
    LISTING_COUNT,
    ax_nodes_for_results,
    build_results_document,
    element,
    expansion_for_results,
    text,
)

from browser_service.browser.navigation import NavigationResult, ReadOnlyOperation
from browser_service.contracts import InvocationExploreWebsite, SuccessResultExploreWebsite
from browser_service.page_observation.cdp import StageBudget
from browser_service.tool_outcome import ToolExecutionError
from browser_service.tools import explore_website as module

TEST_BUDGET = StageBudget(
    total_seconds=6.0,
    navigation_seconds=2.0,
    settle_seconds=0.5,
    capture_seconds=2.0,
    extraction_seconds=0.8,
    validation_seconds=0.2,
    cleanup_seconds=0.4,
)


class FakePage:
    """A page that answers CDP commands, and can stall named ones."""

    def __init__(
        self,
        *,
        document: Any,
        ax_nodes: list[Any] | None = None,
        expansions: dict[int, Any] | None = None,
        stall: frozenset[str] = frozenset(),
    ) -> None:
        self.document = document
        self.ax_nodes = ax_nodes or []
        self.expansions = expansions or {}
        self.stall = stall
        self.methods: list[str] = []
        self.handlers: list[tuple[Any, Any]] = []
        self.removed: list[tuple[Any, Any]] = []

    def on(self, event: str, handler: Any) -> None:
        self.handlers.append((event, handler))

    def remove_listener(self, event: str, handler: Any) -> None:
        self.removed.append((event, handler))

    async def send(self, method: str, params: dict[str, Any] | None = None) -> Any:
        given = dict(params or {})
        self.methods.append(method)
        if method in self.stall:
            await asyncio.sleep(3_600)
        if method == "DOM.getDocument":
            return {"root": self.document}
        if method == "DOM.describeNode":
            return {
                "node": self.expansions.get(int(given["backendNodeId"]), element(0, "div"))
            }
        if method == "Accessibility.getFullAXTree":
            return {"nodes": self.ax_nodes}
        if method == "Accessibility.getPartialAXTree":
            return {"nodes": []}
        if method == "DOM.getBoxModel":
            return {"model": {"content": [0, 0, 320, 0, 320, 240, 0, 240]}}
        if method in {"DOM.enable", "DOM.disable"}:
            return {}
        raise AssertionError(f"unexpected command: {method}")


class FakeContext:
    def __init__(self, page: FakePage) -> None:
        self._page = page

    async def open_page(self) -> FakePage:
        return self._page

    async def open_cdp_session(self, page: FakePage) -> FakePage:
        # One object plays both roles here: the fake answers page calls and
        # CDP calls alike, so the pipeline's split between them stays visible
        # in the assertions without a second double.
        return page


class FakeManager:
    def __init__(self, page: FakePage) -> None:
        self._page = page
        self.contexts_opened = 0
        self.contexts_closed = 0

    @contextlib.asynccontextmanager
    async def isolated_context(self) -> Any:
        self.contexts_opened += 1
        try:
            yield FakeContext(self._page)
        finally:
            self.contexts_closed += 1


class FakeNavigation:
    """Stands in for `NavigationService` so the pipeline under test is the
    exploration flow, not the (separately tested) navigation internals."""

    html_content: str | None = "<html><body><p>full serialization</p></body></html>"
    get_content_stalls = False
    calls: list[str] = []

    def __init__(self, policy: Any, limits: Any = None) -> None:
        self.limits = limits

    async def navigate(self, page: Any, url: str, *, cancelled: Any = None) -> NavigationResult:
        FakeNavigation.calls.append("navigate")
        return NavigationResult(
            operation=ReadOnlyOperation.NAVIGATE,
            requested_url=url,
            final_url=url,
            redirect_count=0,
        )

    async def get_content(self, page: Any, *, cancelled: Any = None) -> NavigationResult:
        FakeNavigation.calls.append("get_content")
        if FakeNavigation.get_content_stalls:
            await asyncio.sleep(3_600)
        return NavigationResult(
            operation=ReadOnlyOperation.GET_CONTENT,
            requested_url=COLLECTION_URL,
            final_url=COLLECTION_URL,
            redirect_count=0,
            content=FakeNavigation.html_content,
        )


@pytest.fixture(autouse=True)
def _reset_fake_navigation() -> Any:
    FakeNavigation.calls = []
    FakeNavigation.html_content = "<html><body><p>full serialization</p></body></html>"
    FakeNavigation.get_content_stalls = False
    yield


def invocation(url: str = COLLECTION_URL) -> InvocationExploreWebsite:
    return InvocationExploreWebsite.model_validate(
        {
            "contractVersion": 1,
            "correlation": {"requestId": "req-1", "userId": "user-1", "sessionId": "session-1"},
            "toolCallId": "call-1",
            "toolName": "browser.explore_website",
            "arguments": {"url": url, "goal": "compare six stays"},
        }
    )


async def explore(
    page: FakePage, monkeypatch: pytest.MonkeyPatch, *, budget: StageBudget | None = None
) -> Any:
    monkeypatch.setattr(module, "NavigationService", FakeNavigation)
    manager = FakeManager(page)
    return await module.run_explore_website(
        invocation(),
        asyncio.Event(),
        manager=manager,  # type: ignore[arg-type]
        budget=budget or TEST_BUDGET,
    )


# --------------------------------------------------------------------------
# Steps 1-2: no mandatory full-page HTML serialization
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_exploration_succeeds_without_serializing_the_whole_page(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = FakePage(document=build_results_document(), ax_nodes=ax_nodes_for_results())

    outcome = await explore(page, monkeypatch)

    # The one thing this repair is about: a useful observation without a
    # second unlimited whole-page representation.
    assert FakeNavigation.calls == ["navigate"], "get_content must not be on the success path"
    assert outcome.payload["document"]["chunks"]
    assert outcome.payload["pageUnderstanding"]["untrusted"] is True


@pytest.mark.asyncio
async def test_exploration_succeeds_when_full_html_serialization_stalls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    FakeNavigation.get_content_stalls = True
    page = FakePage(document=build_results_document(), ax_nodes=ax_nodes_for_results())

    async with asyncio.timeout(10):
        outcome = await explore(page, monkeypatch)

    # The reproduced failure, inverted: HTML serialization would hang
    # forever, and the exploration completes anyway.
    assert outcome.payload["document"]["chunks"]
    assert "get_content" not in FakeNavigation.calls


@pytest.mark.asyncio
async def test_the_html_fallback_is_optional_bounded_and_only_for_an_empty_observation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # An observation with structure but no text at all.
    empty = element(1, "html", children=[element(10, "body", children=[element(11, "div")])])
    page = FakePage(document=empty)
    FakeNavigation.html_content = (
        "<html><body><main><p>" + ("Recovered sentence. " * 20) + "</p></main></body></html>"
    )

    outcome = await explore(page, monkeypatch)

    assert FakeNavigation.calls == ["navigate", "get_content"]
    assert outcome.payload["document"]["chunks"]
    notes = outcome.payload["pageUnderstanding"]["coverage"]["notes"]
    assert any("full page serialization" in note for note in notes)


@pytest.mark.asyncio
async def test_a_stalled_html_fallback_degrades_instead_of_failing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Structure but no citable text: the observation yields records, so the
    # fallback is attempted -- and when it stalls, the exploration still
    # succeeds on what the observation already holds.
    textless = element(
        1,
        "html",
        children=[
            element(
                10,
                "body",
                children=[
                    element(
                        20 + index,
                        "a",
                        attributes={
                            "href": f"https://stays.test/rooms/{index}",
                            "aria-label": f"Listing {index}",
                        },
                    )
                    for index in range(LISTING_COUNT)
                ],
            )
        ],
    )
    FakeNavigation.get_content_stalls = True
    page = FakePage(document=textless)

    async with asyncio.timeout(15):
        outcome = await explore(page, monkeypatch)

    assert FakeNavigation.calls == ["navigate", "get_content"]
    notes = outcome.payload["pageUnderstanding"]["coverage"]["notes"]
    assert any("exceeded its budget" in note for note in notes)
    assert outcome.payload["pageUnderstanding"]["nodes"]


# --------------------------------------------------------------------------
# Step 3: one total budget, divided, with remaining-budget propagation
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stages_share_one_total_budget_rather_than_each_owning_a_full_clock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = FakePage(
        document=build_results_document(truncate_at_depth=True),
        ax_nodes=ax_nodes_for_results(),
        expansions={20: expansion_for_results()},
        stall=frozenset({"DOM.describeNode"}),
    )

    started = asyncio.get_running_loop().time()
    async with asyncio.timeout(TEST_BUDGET.total_seconds + 4):
        with contextlib.suppress(ToolExecutionError):
            await explore(page, monkeypatch)
    elapsed = asyncio.get_running_loop().time() - started

    # Six stages that each owned the full total would run far past it.
    assert elapsed < TEST_BUDGET.total_seconds + 3


def test_the_shipped_budget_divides_its_total_and_matches_the_renderer_mirror() -> None:
    budget = module.EXPLORATION_BUDGET
    stages = (
        budget.navigation_seconds,
        budget.settle_seconds,
        budget.capture_seconds,
        budget.extraction_seconds,
        budget.validation_seconds,
        budget.cleanup_seconds,
    )
    assert sum(stages) <= budget.total_seconds
    # The renderer's outer deadline mirrors this total (see
    # apps/renderer/src/server/browser-service/timeouts.ts) and must stay
    # strictly larger, which its own suite asserts against this number.
    assert budget.total_seconds == 45.0


# --------------------------------------------------------------------------
# Step 4: typed partial success, and TIMEOUT only when nothing is usable
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_bounded_capture_reports_partial_success_with_coverage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = FakePage(
        document=build_results_document(truncate_at_depth=True),
        ax_nodes=ax_nodes_for_results(),
        expansions={20: expansion_for_results()},
        stall=frozenset({"DOM.describeNode"}),
    )

    outcome = await explore(page, monkeypatch)

    understanding = outcome.payload["pageUnderstanding"]
    assert understanding["status"] == "partial"
    assert understanding["truncations"], "a partial observation must say what it dropped"
    assert understanding["coverage"]["inaccessibleRegionCount"] >= 1
    assert any("capture budget" in t["reason"] for t in understanding["truncations"])


@pytest.mark.asyncio
async def test_timeout_only_when_no_safe_useful_result_can_be_produced(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = FakePage(document=build_results_document(), stall=frozenset({"DOM.getDocument"}))

    async with asyncio.timeout(15):
        with pytest.raises(ToolExecutionError) as excinfo:
            await explore(page, monkeypatch)

    assert excinfo.value.code == "TIMEOUT"
    assert excinfo.value.retryable is True


@pytest.mark.asyncio
async def test_a_complete_capture_is_not_reported_as_partial(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = FakePage(document=build_results_document(), ax_nodes=ax_nodes_for_results())

    outcome = await explore(page, monkeypatch)

    assert outcome.payload["pageUnderstanding"]["status"] == "complete"


# --------------------------------------------------------------------------
# Step 5: evidence refers only to retained normalized content
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_evidence_quotes_only_text_the_observation_retained(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    document = build_results_document()
    # Text that exists in the page but sits below the node budget cut.
    document["children"][1]["children"][1]["children"].append(
        element(90_000, "p", children=[text(90_001, "SECRET-BELOW-THE-BUDGET")])
    )
    page = FakePage(document=document, ax_nodes=ax_nodes_for_results())

    outcome = await explore(
        page,
        monkeypatch,
        budget=StageBudget(
            total_seconds=6.0,
            navigation_seconds=2.0,
            settle_seconds=0.5,
            capture_seconds=2.0,
            extraction_seconds=0.8,
            validation_seconds=0.2,
            cleanup_seconds=0.4,
        ),
    )

    # Every evidence snippet must be a substring of the retained chunk text,
    # so a citation can never quote content the observation dropped.
    chunk_text = " ".join(chunk["text"] for chunk in outcome.payload["document"]["chunks"])
    assert outcome.evidence
    for item in outcome.evidence:
        assert item["snippet"] in chunk_text
        assert item["sourceUrl"] == COLLECTION_URL


@pytest.mark.asyncio
async def test_records_and_criteria_survive_the_bounded_observation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = FakePage(document=build_results_document(), ax_nodes=ax_nodes_for_results())

    outcome = await explore(page, monkeypatch)

    text_blob = " ".join(chunk["text"] for chunk in outcome.payload["document"]["chunks"])
    assert "Capitol Hill Loft" in text_blob
    assert "Green Lake Cottage" in text_blob
    assert CHECK_IN in text_blob and CHECK_OUT in text_blob
    # Six listing-shaped records were supplied and must survive.
    assert text_blob.count("per night") == LISTING_COUNT


# --------------------------------------------------------------------------
# Contract conformance and cleanup
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_payload_conforms_to_the_generated_success_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = FakePage(document=build_results_document(), ax_nodes=ax_nodes_for_results())

    outcome = await explore(page, monkeypatch)

    SuccessResultExploreWebsite.model_validate(
        {
            "contractVersion": 1,
            "correlation": {"requestId": "req-1", "userId": "user-1", "sessionId": "session-1"},
            "toolCallId": "call-1",
            "status": "success",
            "payload": outcome.payload,
            "sensitivity": {"sensitive": False, "confirmationRequired": False},
        }
    )


@pytest.mark.asyncio
async def test_the_dom_domain_is_released_and_the_context_closed_on_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = FakePage(document=build_results_document(), ax_nodes=ax_nodes_for_results())
    monkeypatch.setattr(module, "NavigationService", FakeNavigation)
    manager = FakeManager(page)

    await module.run_explore_website(
        invocation(), asyncio.Event(), manager=manager, budget=TEST_BUDGET  # type: ignore[arg-type]
    )

    assert "DOM.disable" in page.methods
    assert manager.contexts_closed == 1
    assert len(page.removed) == len(page.handlers) > 0


@pytest.mark.asyncio
async def test_the_dom_domain_is_released_after_a_timeout_too(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = FakePage(document=build_results_document(), stall=frozenset({"DOM.getDocument"}))
    monkeypatch.setattr(module, "NavigationService", FakeNavigation)
    manager = FakeManager(page)

    async with asyncio.timeout(15):
        with pytest.raises(ToolExecutionError):
            await module.run_explore_website(
                invocation(), asyncio.Event(), manager=manager, budget=TEST_BUDGET  # type: ignore[arg-type]
            )

    assert "DOM.disable" in page.methods
    assert manager.contexts_closed == 1
