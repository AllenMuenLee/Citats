# Phase 2 Repair — Mistral Web Routing

## Mission

Repair the Phase 2 Mistral integration so the model can choose between hosted Web Search and the local read-only browser path without losing custom tool definitions or tool results. General research should use Web Search; requests that require inspecting website content should discover URLs when necessary and then read them through `browser.navigate_and_extract`.

## Isolation rule

Read only the requirements, `Claude.md`, `AGENTS.md`, `implementation_prompts/phase-02/phase-02-read-only-browsing.md`, and the relevant Mistral adapter, orchestrator, browser-service client, contract, and test files. Do not read another implementation prompt; impose this on subagents.

## Prerequisites

- Phase 2 features P02-F01 through P02-F04 are complete.
- `browser.navigate_and_extract` can navigate a safe public URL and return bounded citable chunks.
- The orchestrator tool loop can execute a registered custom function and append its result.

## Feature builds

### P02-R01 Restore custom function calling across the Conversations adapter

- **Tools:** Mistral TypeScript SDK, Conversations API event types, canonical tool registry, Vitest.
- **Depends on:** P02-F04.
- **Concurrency:** parallel with P02-R02 using exclusive Mistral-adapter and routing-policy files; integrate before P02-R03.
- **Build steps:**
  1. Reproduce the defect with an adapter test proving that the current request advertises fixed hosted tools while omitting `request.tools`, and that it removes local `tool` result turns.
  2. Extend the Conversations request mapping to include supplied custom functions in the provider's canonical function-tool shape alongside only the hosted tools explicitly enabled for that request.
  3. Preserve the complete custom-tool exchange required by the API: assistant function call, locally executed function result, and the subsequent synthesis request. Use provider-native Conversation entries or a supported continuation call rather than flattening away tool identity.
  4. Map streamed custom function-call events to the existing `tool-call-delta` contract while keeping hosted-tool execution events mapped to `hosted-tool-status`; validate names and arguments before dispatch.
  5. Remove the unconditional `MISTRAL_HOSTED_TOOLS` behavior. Web Search, code execution, and image generation must each be enabled explicitly and independently.
- **Validate:** adapter fixtures for custom calls, fragmented arguments, hosted events, mixed allowed tools, tool results, cancellation, malformed events, and proof that credentials never enter events or logs.

### P02-R02 Add a trusted routing decision

- **Tools:** Zod/shared contracts, server instruction policy, routing tests.
- **Depends on:** P01-F03 and P02-F04.
- **Concurrency:** parallel with P02-R01; own routing schema/policy files and their tests.
- **Build steps:**
  1. Define a strict routing result with exactly two outcomes: `web_search_only` and `website_read_required`. The decision must be produced under server-owned instructions and parsed before tools are exposed or executed.
  2. Route general questions, current-information lookup, and source discovery that do not require page inspection to `web_search_only`.
  3. Route requests to read, summarize, quote, verify, or compare website contents to `website_read_required`. Treat an explicit URL plus an instruction to inspect it as website reading.
  4. For ambiguous decisions, choose the least-capable route that can answer accurately. A malformed decision must fail closed with a safe retryable response, not silently enable all tools.
  5. Keep classification text out of the user-visible answer and attach correlation-safe metrics for route choice, fallback, and failure without recording raw prompts or page content.
- **Validate:** a fixed classifier matrix covering explicit URLs, named but unknown sites, current events, broad factual questions, page summaries, quotations, comparisons, prompt injection attempts, and ambiguous requests.

### P02-R03 Execute the selected route end to end

- **Tools:** orchestrator, hosted Web Search, browser service client, citation resolver, end-to-end tests.
- **Depends on:** P02-R01 and P02-R02.
- **Concurrency:** integrate after dependencies.
- **Build steps:**
  1. For `web_search_only`, expose hosted `web_search`, keep `browser.navigate_and_extract` unavailable, and render Mistral's safe source references through the existing source UI.
  2. For `website_read_required` with an explicit safe URL, skip Web Search and invoke `browser.navigate_and_extract` directly.
  3. For `website_read_required` without a URL, run Web Search for discovery, collect only safe HTTP(S) candidate URLs from structured references, normalize and deduplicate them, apply the server URL policy, and invoke `browser.navigate_and_extract` on the bounded selected set.
  4. Require claims about locally read pages to cite returned chunk IDs. Do not treat a Web Search snippet as page evidence, and never fabricate page content when search, navigation, extraction, or citation validation fails.
  5. Preserve Phase 2's read-only boundary: no click, form, authentication, script-evaluation, private-API discovery, or mutation capability may be registered by this repair.
  6. Add route-level progress events that distinguish searching, selecting sources, navigating, extracting, and synthesizing without exposing raw authenticated or untrusted page data.
- **Validate:** integration tests proving exact tool availability and call order for both routes, plus unsafe URL rejection, empty discovery, duplicate sources, partial page failures, truncation, cancellation, deadlines, and repeated-session resource cleanup.

## Repair acceptance

Run the Phase 1 Mistral/orchestrator suites, the Phase 2 navigation/extraction/citation suites, and the new routing golden matrix. The repair is complete only when custom tool calls execute through the active production adapter, general research never launches the local browser, website-reading requests use locally extracted evidence, and all existing read-only and credential-safety checks pass.
