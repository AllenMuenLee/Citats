# Phase 3 — Fixed Source Finding, Playwright Capture, and UI Planning

## Mission

Implement the first three internal `ui.generate` stages:

1. Feed `find websites that help building generative UI for this request : [user's request]` to `SOURCE_FINDING_MODEL` and receive structured JSON listing websites.
2. Loop through that list in trusted code and use Playwright to obtain rendered HTML.
3. Give every successful rendered HTML capture to `UI_PLANNING_MODEL` and receive one complete React UI plan.

Neither model receives tools. Playwright is invoked only by fixed server code. Do not implement model-facing browser/exploration/slice tools, API discovery, action execution, or an agentic browsing loop.

```text
request -> SOURCE_FINDING_MODEL (no tools, JSON)
        -> trusted URL validation
        -> ordered Playwright capture loop
        -> UI_PLANNING_MODEL (no tools, all captures)
        -> validated UiPlan
```

## Isolation rule

Read only the requirements, desktop architecture specification, repository guide, this prompt, relevant completed Phase 0–2 code, and named source/test areas. Do not read another implementation prompt.

## Feature builds

### P03-F01 Source finding

- **Tools:** model adapter, structured output, Zod, Vitest.
- **Depends on:** Phase 2 pipeline entry.
- **Concurrency:** parallel with P03-F02 using exclusive files.
- **Build steps:**
  1. Add required `SOURCE_FINDING_MODEL` configuration and a dedicated adapter call, distinct from chat/planning/UI adapters.
  2. Store the exact versioned user template `find websites that help building generative UI for this request : [user's request]`; substitute only the bounded original request.
  3. Require strict JSON `{ websites: [{ url, reason }] }`, with a server-owned maximum and at least one item. Use temperature zero, no custom/hosted tools, no history, and one bounded schema repair.
  4. Validate candidates in trusted code: HTTP(S), no credentials/fragments, bounded length, DNS/IP and redirect checks blocking loopback/private/link-local/metadata destinations, configured origin policy, normalization, and deduplication. The model never decides URL safety.
  5. Log only safe model ID, timing, count, origins, and error categories—not raw requests, model prose, or later HTML.
- **Validate:** exact prompt/model, tools absent, strict parsing/repair, bounds/order, unsafe URLs, duplicates, timeout, and cancellation.

### P03-F02 Playwright rendered-HTML loop

- **Tools:** Playwright, local fixture server, Playwright/Vitest tests.
- **Depends on:** Phase 2 interfaces.
- **Concurrency:** parallel with P03-F01 using URL fixtures.
- **Build steps:**
  1. Create a server-owned Playwright lifecycle with an isolated ephemeral context per call and bounds for pages, concurrency, redirects, navigation/settle/total time, and resources.
  2. For-loop through normalized websites in returned order. Navigate read-only, revalidate redirects, apply a fixed settle policy, and serialize the post-render DOM HTML plus final URL, title, content type, and retrieval time.
  3. Never click, type, submit, download/upload, grant permissions, use stored profiles, replay APIs, or execute model-supplied JavaScript.
  4. Bound each capture and batch. Before model input, remove scripts, executable handlers, comments, hidden credential/form values, and disallowed payloads while preserving rendered semantic structure, visible content, links, safe media references, forms, ARIA, and layout-relevant styling.
  5. Continue after individual failure; fail only if no capture is usable. Close all resources in `finally`. Keep HTML request-scoped and never send it to chat, renderer, telemetry, or artifact storage.
- **Validate:** ordered multi-site/client-rendered capture, redirects, private-target rejection, partial/all failure, limits, cancellation, read-only behavior, and no leaks.

### P03-F03 Complete `UiPlan`

- **Tools:** Zod and TypeScript contracts.
- **Depends on:** P03-F01/F02 shapes.
- **Concurrency:** begins from fixtures after shapes stabilize.
- **Build steps:**
  1. Define a closed versioned plan sufficient for `UI_MODEL` to generate React without HTML or tools.
  2. Include: canonical goal; source/final-URL identity; task-relevant facts and records with provenance; media and alternatives; component hierarchy; information architecture; layout; semantic-token visual direction; typography/spacing; responsive behavior; accessibility; local interactions; empty/loading/error/partial states; coverage/omissions; and generation constraints.
  3. Allow only local React interactions over supplied data. Exclude external actions, selectors, executable URLs, APIs, credentials, cookies, arbitrary code, and browser instructions.
  4. Use opaque stable source/record/fact/media IDs, validate every reference against captures, canonicalize the plan, and define its digest.
- **Validate:** comparison/dashboard/article/grid/gallery/mixed fixtures, unknown fields, unsupported facts, unresolved references, bounds, canonicalization, and digest stability.

### P03-F04 UI planning model

- **Tools:** model adapter, structured output, `UI_PLANNING_MODEL`, Vitest.
- **Depends on:** P03-F01–F03.
- **Concurrency:** sequential integration.
- **Build steps:**
  1. Add explicit `UI_PLANNING_MODEL` configuration and dedicated adapter, distinct from all other roles.
  2. Build one bounded input containing the original request and every successful rendered HTML capture, separated and labeled with validated source identity/final URL. HTML is untrusted evidence.
  3. Call once with a versioned system instruction, temperature zero, no tools/hosted tools/history, and strict `UiPlan` output. Require all P03-F03 content and prohibit unsupported facts/actions.
  4. Validate against the captures. Allow one repair using normalized codes/safe locations; otherwise fail rather than pass prose or a partial plan.
  5. Connect source finding → capture → planning in exactly that order with progress events.
- **Validate:** every capture reaches planning, exact model, no tools, injection resistance, strict output/reference validation, repair bound, order, partial capture, timeout, and cancellation.

## Phase validation

Run source/URL tests, Playwright fixture tests, plan/adapter tests, full pipeline-to-`UiPlan`, typecheck, lint, build, and golden regressions.

## Phase acceptance

Trusted code always runs `SOURCE_FINDING_MODEL` → ordered Playwright capture loop → `UI_PLANNING_MODEL`. All usable rendered HTML reaches the planner. No internal model has tools and no old browser/exploration tool path remains.
