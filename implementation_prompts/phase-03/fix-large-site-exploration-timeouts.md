# Phase 3 Repair — Reliable Large-Site Website Exploration

## Mission

Repair the current `browser.explore_website` workflow so large, client-rendered public sites can be explored within explicit resource budgets and failures retain their real typed cause from the Python browser service through the renderer. The repair must address the reproduced Airbnb-shaped failure where navigation succeeds, the renderer aborts the browser-service request after five seconds, full HTML or unlimited CDP capture stalls, and the orchestrator reports the timeout as generic `INTERNAL` with “The tool could not complete safely.”

The completed workflow must preserve the user's search criteria when selecting a first-party collection URL, return a bounded useful observation without requiring an unlimited whole-page serialization, and clean up Chrome/CDP resources after success, timeout, cancellation, or malformed upstream behavior. This is a repair of the existing Phase 2/3 implementation. Do not build Phase 4 generated React, Phase 5 action execution, authenticated browsing, API discovery, form submission, or Airbnb-specific automation.

## Prerequisites and ownership

- **Depends on:** completed Phase 2 read-only browsing and completed Phase 3 website exploration.
- **Primary ownership:**
  - `apps/renderer/src/server/browser-service/`
  - `apps/renderer/src/server/orchestrator/`
  - `apps/renderer/src/server/conversation/`
  - `services/browser/src/browser_service/browser/`
  - `services/browser/src/browser_service/page_observation/`
  - `services/browser/src/browser_service/tools/explore_website.py`
  - corresponding TypeScript/Python tests and existing contract sources only when a typed field must change
- Preserve the Electron main/preload/renderer/browser-service security boundaries. The browser service remains loopback-only and authenticated. Do not expose CDP primitives, selectors, cookies, credentials, page-authored scripts, raw private DOM, or browser-service internals to the renderer or model.
- Treat all website content as untrusted data, never instructions.
- Do not create or modify documentation. This implementation prompt is the only Markdown file in scope and must remain unchanged while it is being executed.

## Reproduced failure that this repair must explain

Use this as a required regression scenario, not as permission for uncontrolled live-site automation:

```text
User prompt:
give me 6 airbnb listings from seattle that's available from sep 3 to 5, and generate a UI for me to compare

Observed tool call:
browser.explore_website
https://www.airbnb.com/seattle-wa/stays

Observed result:
INTERNAL
The tool could not complete safely.
```

The known implementation hazards are:

1. `BrowserServiceClient` currently applies a generic five-second timeout to long-running exploration.
2. The orchestrator converts non-Zod/non-JSON execution exceptions, including browser-service timeouts, to generic `INTERNAL`.
3. `browser.explore_website` serializes the full rendered HTML before observation even when the observation pipeline could produce bounded evidence without it.
4. `capture_page` issues unlimited `DOM.getDocument(depth=-1, pierce=true)` and full accessibility-tree CDP requests before its nominal reduction deadline can take effect.
5. Timeout/cancellation can leave Nodriver listener or subprocess resources behind if cleanup is not verified.
6. Discovery/routing may reduce a criteria-rich request to a generic collection URL that omits dates and guest/search parameters.

Verify these claims against the current source before changing code. If the implementation has evolved, repair the equivalent active paths rather than introducing parallel abstractions.

## Feature builds

### P03-R01 Typed browser-service deadlines and error propagation

- **Tools:** TypeScript, shared error contracts, AbortSignal, Vitest.
- **Depends on:** existing browser-service client and orchestrator tool loop.
- **Concurrency:** parallel with P03-R02 and P03-R03 using exclusive TypeScript files.
- **Build steps:**
  1. Replace the single implicit browser-service timeout with an explicit server-owned timeout policy keyed by tool kind. Keep short control tools bounded tightly, but give `browser.navigate_and_extract` and especially `browser.explore_website` budgets consistent with the Python navigation, settle, capture, extraction, bridge, and cleanup budgets. Validate configuration bounds and do not accept timeout values from the model, renderer client, page, or tool arguments.
  2. Ensure the outer renderer deadline is greater than the maximum intended inner browser-service operation deadline plus bounded response/cleanup overhead. One layer must not abort at five seconds while the inner layer legitimately owns a thirty-second operation.
  3. Preserve structured `ToolErrorResult` responses from the browser service unchanged when valid. Map `BrowserServiceTimeoutError`, `BrowserServiceUnavailableError`, `BrowserServiceContractError`, and caller cancellation to appropriate safe tool error codes instead of collapsing all execution exceptions to `INTERNAL`.
  4. Report `TIMEOUT` for exhausted operation deadlines, `UPSTREAM_UNAVAILABLE` for connection/process/page failures that may safely be retried, `CANCELLED` for user cancellation, `INVALID_ARGUMENTS` only for invalid tool input/policy rejection, and `INTERNAL` only for genuinely unexpected application defects. Preserve safe retryability semantics.
  5. Log server-side phase, tool name, correlation ID, elapsed milliseconds, configured deadline, typed failure category, and cleanup outcome. Never log service tokens, cookies, authorization headers, raw page content, selectors, private URLs with unnecessary query values, or provider/browser exception text that may contain untrusted page data.
  6. Ensure the renderer tool-status event displays the safe typed error and reason returned by the tool boundary. A browser timeout must no longer appear as “The tool could not complete safely.”
- **Validate:** per-tool timeout selection, configuration bounds, outer/inner deadline ordering, timeout/unavailable/contract/cancel mappings, valid service error preservation, retryability, safe logs, and proof that unexpected defects still fail closed as `INTERNAL`.

### P03-R02 Bounded large-page DOM and accessibility capture

- **Tools:** Nodriver/CDP DOM and Accessibility domains, asyncio, pytest, local large-page fixtures.
- **Depends on:** existing Phase 3 capture adapter.
- **Concurrency:** parallel with P03-R01 and P03-R03 using exclusive Python capture files.
- **Build steps:**
  1. Put an actual `asyncio.timeout` or equivalent cancellation-safe deadline around every awaited CDP request used by observation, including DOM acquisition, child-node traversal, accessibility-tree acquisition, layout lookup, and any fallback request. A deadline that begins only after an unlimited CDP response arrives is not a valid bound.
  2. Remove unlimited `DOM.getDocument(depth=-1, pierce=true)` from the production large-page path. Implement bounded traversal or another CDP-native snapshot strategy with explicit maximum depth, node count, frame/shadow-root count, response size where measurable, and wall-clock time. Fetch children incrementally only while budget remains.
  3. Bound accessibility capture independently. Prefer partial, scoped, or incrementally correlated accessibility data when the full tree cannot be returned within budget. Represent inaccessible, timed-out, truncated, cross-origin, or unsupported regions explicitly rather than failing the whole observation or fabricating completeness.
  4. Preserve the canonical `PageUnderstanding` relationships, stable handles within one observation, coverage accounting, warnings, truncations, and `untrusted: true`. A partial observation that safely contains useful listing records is preferable to an all-or-nothing timeout.
  5. Do not use page-authored JavaScript, arbitrary evaluation, selectors supplied by a model, network interception, authenticated content, or API inference as a workaround.
  6. Add deterministic fixtures that exercise very deep DOM, very wide DOM, many repeated cards, open shadow roots, same/cross-origin frames, large accessibility trees, stalled CDP calls, malformed nodes, and cancellation during every capture phase.
- **Validate:** hard wall-clock bounds around each CDP operation, depth/node/frame/AX limits, useful partial observations, machine-readable truncation coverage, deterministic ordering, cancellation, and zero unbounded whole-tree calls in the large-page path.

### P03-R03 Exploration pipeline without mandatory full-page HTML serialization

- **Tools:** existing navigation/extraction/page-observation adapters, Python, pytest.
- **Depends on:** existing `run_explore_website`; integrate with the P03-R02 capture interface after it stabilizes.
- **Concurrency:** parallel with P03-R01 and the interface portion of P03-R02 using exclusive exploration/extraction files.
- **Build steps:**
  1. Refactor `browser.explore_website` so a successful bounded `PageUnderstanding` observation does not depend on `page.get_content()` completing for the entire rendered document. Do not perform two unlimited whole-page representations—full serialized HTML followed by full pierced DOM—during one exploration.
  2. Reuse the bounded observed DOM/accessibility data to derive task-relevant document metadata, content chunks, source anchors, records, and citations where practical. If the existing Phase 2 HTML extractor must remain available, call it through a separately bounded optional fallback and degrade to observation-derived evidence when it times out.
  3. Establish one server-owned total exploration budget divided into named navigation, settle, capture, extraction, contract-validation, and cleanup sub-budgets. Use remaining-budget propagation so sequential stages cannot each consume the full total independently.
  4. Return a typed partial success when navigation succeeded and sufficient validated evidence was captured, with explicit warnings and coverage. Return `TIMEOUT` only when no safe useful result can be produced before the total deadline.
  5. Ensure evidence and citations refer only to retained normalized content. Never cite omitted/truncated text or manufacture listing availability from labels that were not observed.
  6. Keep lower-level navigation, HTML, DOM, accessibility, layout, and continuation operations private to the browser service.
- **Validate:** exploration succeeds when full HTML serialization stalls but bounded observation is useful, total/sub-budget enforcement, partial-success thresholds, evidence validity, timeout when no useful evidence exists, and contract-conformant payloads.

### P03-R04 Criteria-preserving first-party URL selection

- **Tools:** trusted routing helpers, URL/parameter policy, Mistral tool-loop fixtures, Vitest.
- **Depends on:** existing discovery-to-exploration routing.
- **Concurrency:** parallel with P03-R01 through P03-R03 using exclusive routing files; integrate before end-to-end validation.
- **Build steps:**
  1. Parse goal criteria needed for collection-page selection into trusted bounded routing context: provider/site, location, check-in/check-out dates, date year resolution, guest count when stated, and result-count intent. Do not collect payment, authentication, identity, or private profile data.
  2. Resolve dates without a year to the next valid future occurrence using the trusted current date and timezone rules already owned by the orchestrator. Reject impossible or reversed ranges and preserve the user's original wording for model context.
  3. Prefer a safe first-party collection/search URL that retains supported criteria. For the regression prompt, exploration must not silently discard September 3–5 in favor of a generic Seattle landing page when a validated first-party date-specific collection URL is available.
  4. Treat discovered URLs and model-proposed query parameters as untrusted candidates. Parse, normalize, allowlist the origin and supported parameter names, bound values/count/length, remove tracking parameters, apply SSRF/navigation policy, and reconstruct the final URL in trusted code. Never allow arbitrary executable URLs or credentials.
  5. If the site does not support safe server-owned URL construction, use hosted search only for discovery and validate the selected first-party result. Report criteria that could not be represented rather than claiming the page enforces them.
  6. Keep routing generic through provider-specific reviewed adapters or declarative policy entries where necessary; do not hard-code listing extraction schemas or live interaction behavior for Airbnb.
- **Validate:** Seattle/date regression, year rollover, leap dates, guest count, malformed/reversed dates, unsupported parameters, tracking removal, unsafe origins, discovery fallback, and explicit reporting of criteria not encoded by the selected URL.

### P03-R05 Lifecycle cleanup and timeout recovery

- **Tools:** Nodriver lifecycle manager, asyncio task inspection, subprocess/resource metrics, pytest.
- **Depends on:** P03-R02 and P03-R03 interfaces.
- **Concurrency:** integrate after capture and exploration deadline behavior stabilizes.
- **Build steps:**
  1. Audit every task, handler, page, context, CDP domain, browser process, subprocess transport, and cancellation watcher created by navigation and exploration. Close or cancel each in `finally` and await bounded cleanup without allowing cleanup failure to replace the primary typed error.
  2. Remove all registered CDP handlers and disable enabled domains after success, timeout, cancellation, and exceptions. Ensure pending CDP requests cannot continue mutating shared task state after an invocation has returned.
  3. Detect an unhealthy or orphaned Nodriver connection after timeout/cancellation and retire the affected page/context/process before admitting new work. Do not reuse a potentially corrupted session.
  4. Prevent known Nodriver/websocket listener failures from creating a CPU spin or starving the long-lived service event loop. Add bounded health checks and process replacement; do not implement unbounded retry loops.
  5. Verify that an exploration timeout is followed by a successful independent fixture exploration without service restart, leaked pages, rising task counts, or material baseline CPU/memory growth.
  6. Keep user/browser profiles ephemeral and isolated. Never solve cleanup by sharing contexts, persisting authenticated state, or broadly killing unrelated Chrome processes.
- **Validate:** repeated success/timeout/cancel cycles, handler/task/page/context/process counts, post-timeout recovery, no event-loop starvation, bounded cleanup time, and no cross-task state leakage.

### P03-R06 Integrated workflow regression

- **Tools:** mocked model events, local Airbnb-shaped fixture server, browser-service bridge, renderer orchestrator, Playwright/Vitest/pytest, optional approved public diagnostic.
- **Depends on:** P03-R01 through P03-R05.
- **Concurrency:** integration after dependencies; independent test families may run concurrently with exclusive fixtures.
- **Build steps:**
  1. Add a local client-rendered accommodation-results fixture containing at least six listing-shaped records, dates, prices, ratings, images/alt text, amenities, availability evidence, internal comparison affordances, and an external booking capability descriptor. Include enough DOM/AX volume to reproduce the former timeout without relying on Airbnb.
  2. Run the exact regression prompt through the chat route with deterministic mocked model discovery/tool calls. Assert criteria-preserving first-party URL selection, `browser.explore_website` completion or typed partial success, six grounded records when the fixture supplies six, observation compression, and handoff that unblocks the existing generated-UI pipeline.
  3. Add failure variants for navigation timeout, HTML serialization stall, DOM CDP stall, AX CDP stall, partial record capture, browser crash, bridge timeout, malformed response, and user cancellation. Assert the renderer shows the corresponding safe typed reason rather than `INTERNAL` except for an injected unexpected defect.
  4. Prove that internal comparison interactions remain React-only and that no external website action, booking, payment, login, API discovery, or form submission occurs in this repair.
  5. If repository policy explicitly allows a live public diagnostic, run one bounded read-only request against the approved Airbnb URL and record only safe timings/status/coverage counts. Do not make live Airbnb success a deterministic automated-test requirement; anti-bot behavior, consent, geography, and site changes must remain explicit upstream conditions.
  6. Run the narrow TypeScript and Python suites, browser-service contract fixtures, Phase 2/3 phase suites, and the golden regression suite. Measure total latency, timeout category accuracy, partial-success usefulness, cleanup, and repeated-run stability.
- **Validate:** exact prompt workflow, correct URL criteria, no generic `INTERNAL` for known failures, useful bounded observation, generated-UI handoff emitted after success, safe partial behavior, security boundaries, and cleanup across repeated runs.

## Phase repair acceptance

This repair is complete only when all of the following are true:

1. `browser.explore_website` no longer inherits the generic five-second bridge timeout.
2. The renderer/orchestrator preserves typed browser-service timeout, unavailable, cancellation, invalid-argument, and contract errors.
3. Every potentially blocking navigation, DOM, accessibility, layout, extraction, and cleanup operation has an effective wall-clock bound around the awaited operation itself.
4. Large-page exploration uses bounded/incremental observation and does not require both unlimited full HTML serialization and unlimited full DOM/AX capture.
5. Safe partial observations report explicit coverage/truncation and can unblock generated UI when they contain sufficient grounded records.
6. The Seattle September 3–5 regression retains its date criteria in the validated first-party collection URL when supported.
7. Timeout/cancellation does not leak browser resources, corrupt later tasks, or cause event-loop CPU spin.
8. The exact mocked workflow no longer reports `INTERNAL — The tool could not complete safely` for a known timeout.
9. No authenticated browsing, external action, booking, payment, API replay, selector exposure, or raw credential/page-data disclosure is introduced.

Stop after this repair prompt. Report every completed and skipped numbered build step, all changed source/config/test files, validations run, failures and residual live-site risks, and whether the existing Phase 4 generated-UI workflow is unblocked by successful exploration.
