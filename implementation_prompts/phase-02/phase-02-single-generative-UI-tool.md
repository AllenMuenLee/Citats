# Phase 2 — Single Generative UI Tool

## Mission

Give the conversation model exactly one model-callable capability for UI creation: `ui.generate`. The model decides from the user's request whether a UI is useful. It either answers normally or calls `ui.generate({ request: <exact user request> })` once.

This replaces the former browsing/routing design. Do not expose `browser.navigate_and_extract`, `browser.explore_website`, observation-slice, source-finding, extraction, planning, rendering, or helper tools to the conversation model. Do not automatically generate UI after another tool call. Every stage after `ui.generate` is fixed trusted code implemented in Phases 3 and 4.

```text
user -> conversation model -> text
                           -> ui.generate -> fixed pipeline -> ready/failed
```

## Isolation rule

Read only the requirements, desktop architecture specification, repository guide, this prompt, and relevant Phase 0–1/source areas. Do not read another implementation prompt.

## Feature builds

### P02-F01 Canonical tool contract

- **Tools:** Zod, JSON Schema, generated Pydantic, fixtures.
- **Depends on:** Phase 0 contracts and Phase 1 chat loop.
- **Concurrency:** parallel with P02-F02 using exclusive files.
- **Build steps:**
  1. Define the sole UI tool as `ui.generate`. Its strict versioned arguments contain only bounded `request`, copied exactly from the current user request after transport validation. Do not add URLs, sites, HTML, model settings, plans, code, selectors, or pipeline options.
  2. Define server-emitted progress states: `source_finding`, `page_capture`, `ui_planning`, `ui_generation`, `validation`, and `rendering`. They are events, not tools.
  3. Define a closed result union. `ready` contains only an opaque generated-UI reference and safe display metadata. `failed` contains a stable category and safe message. Neither may expose HTML, prompts, model output, TSX, credentials, cookies, headers, or browser state.
  4. Generate derived schemas from the TypeScript source of truth and reject unknown/oversized fields.
- **Validate:** fixtures, bounds, unknown fields, schema drift, and serialization round trips.

### P02-F02 Conversation tool surface

- **Tools:** chat-model adapter, server-owned instructions, orchestrator tests.
- **Depends on:** P02-F01 draft.
- **Concurrency:** parallel with P02-F01 after the contract draft.
- **Build steps:**
  1. Offer `ui.generate` on every eligible turn as the only custom UI-generation tool. Hosted tools are not part of UI generation.
  2. Instruct the model to call it once with the exact user request when an interactive/visual UI would materially help. The model must not emit code, URLs, plans, or pseudo-tool calls.
  3. After `status: "ready"`, instruct the model to answer with one short confirmation that the UI is ready. After `failed`, it must say generation failed and may answer in text; it must not claim a view exists.
  4. Remove route classifiers, UI-intent regex gates, discovery passes, automatic exploration directives, observation-dependent tools, and all paths that trigger generation without `ui.generate`.
  5. Validate before dispatch, reject unknown/duplicate calls, enforce one call per turn, propagate cancellation/deadlines, and append only the safe result to model context.
- **Validate:** direct answer, one-call UI request, model-owned ambiguous decision, invalid/duplicate call, and truthful ready/failure responses.

### P02-F03 Fixed pipeline entry

- **Tools:** trusted TypeScript service code and Vitest.
- **Depends on:** P02-F01/F02.
- **Concurrency:** sequential integration.
- **Build steps:**
  1. Implement one `generateUi(request, context)` entry called only by the validated dispatcher. It owns identity, correlation, cancellation, deadline, progress, and one terminal result.
  2. Hardcode this order: source finding, page capture, UI planning, UI generation, validation/compilation, registration, rendering readiness. Models cannot add, omit, reorder, or invoke stages.
  3. Define typed internal interfaces for Phases 3–4. They are ordinary code calls and must never be sent as tool definitions.
  4. Until every stage exists, return `failed`; never emit fake readiness.
- **Validate:** exact order, cancellation, progress order, one terminal result, and no model-visible internal stages.

## Phase validation

Run contract generation/tests, orchestrator tests, typecheck, lint, build, and golden conversation regressions.

## Phase acceptance

The chat model has one choice: answer or call `ui.generate`. No other tool or hardcoded classifier participates. Only a real `ready` result lets it tell the user the UI is ready.
