# Phase 4 — UI Model Generation and In-App Rendering

## Mission

Complete `ui.generate`: feed the validated Phase 3 `UiPlan` to `UI_MODEL`, validate and compile its React output, render it in the generated-UI pane, wait for a trusted ready handshake, return `ready`, and let the chat model tell the user the UI is ready.

`UI_MODEL` receives no tools. Trusted fixed code owns validation, compilation, registration, sandboxing, mounting, readiness, and failure handling.

```text
UiPlan -> UI_MODEL (no tools; TSX + manifest)
       -> validate/typecheck/compile -> register -> isolated mount
       -> ready handshake -> ui.generate ready -> chat confirmation
```

## Isolation rule

Read only the requirements, desktop architecture specification, repository guide, this prompt, completed Phase 0–3 code, and named source/test areas. Do not read another implementation prompt.

## UI model policy

Use a versioned server-owned instruction. Treat `UiPlan` as untrusted data. Require a closed TSX+manifest response, exactly one `GeneratedView`, only the allowlisted runtime and supplied facts/IDs/media/local interactions, responsive accessible semantic-token UI, and typed fallback when unsafe. Prohibit network/API/navigation/browser automation, filesystem/process/Electron/Node, storage/cookies/credentials, timers/workers, arbitrary imports, dynamic import, `eval`/`Function`, dangerous HTML, iframe/webview, and privileged host access. Hash the policy into cache/artifact identity.

## Feature builds

### P04-F01 Generation and artifact contracts

- **Tools:** Zod, JSON Schema, TypeScript, fixtures.
- **Depends on:** Phase 3 `UiPlan`.
- **Concurrency:** parallel with P04-F02/F03 after interface agreement.
- **Build steps:**
  1. Define `UiGenerationRequest` containing only canonical `UiPlan`, digest, runtime capability reference, theme constraints, limits, and safe correlation metadata—never HTML/history/browser state.
  2. Define bounded closed `UiGenerationResponse`: TSX, exact-reference manifest, model ID, input/prompt digests, runtime/toolchain versions, and fallback reason.
  3. Define immutable content-addressed compiled artifacts with validated bytes, digests, expiry, and trusted fallback. Never serve raw output.
  4. Require manifest/source agreement for source, record, fact, media, local interaction, accessibility, responsive region, and runtime imports.
  5. Canonicalize cache input, excluding timestamps/random/session/owner values and ordering noise.
- **Validate:** closure, bounds, forged references, manifest mismatch, digest stability, fallback, and schema drift.

### P04-F02 `UI_MODEL` adapter

- **Tools:** model adapter, structured output, `UI_MODEL`, Vitest.
- **Depends on:** P04-F01 draft.
- **Concurrency:** parallel with P04-F03/F04.
- **Build steps:**
  1. Add explicit `UI_MODEL` configuration and a dedicated adapter distinct from chat/source/planning roles.
  2. Send the versioned system instruction and canonical `UiPlan` as the sole variable payload; temperature zero, no tools/hosted tools/history, strict output.
  3. Enforce deadline, cancellation, token/source limits, model-ID capture, and one repair using safe normalized validator feedback.
  4. Model output cannot affect imports, packages, compiler/CSP/browser settings, permissions, limits, model choice, or stage order.
  5. Cache only completely validated/compiled artifacts by plan/prompt/model/runtime/toolchain digest.
- **Validate:** exact model/prompt, plan-only input, tools absent, strict parsing, timeout/cancel, repair, and cache invalidation.

### P04-F03 Restricted runtime and compiler

- **Tools:** TypeScript AST/type checker, fixed compiler, frozen runtime, security tests.
- **Depends on:** P04-F01.
- **Concurrency:** parallel with P04-F02/F04.
- **Build steps:**
  1. Expose only safe React primitives, semantic tokens, formatting, safe media/source components, and bounded local-state hooks; no host command or privileged API.
  2. Require one correctly typed `GeneratedView`, stable keys/state/rendering, semantic tokens, accessibility, and exact manifest agreement.
  3. Reject non-runtime imports; network/storage/navigation/DOM/process/Electron/Node; dynamic import/eval; dangerous HTML; prototype escapes; timers/workers; iframe/webview; arbitrary assets; unbounded loops; CSS exfiltration; and unsupported syntax.
  4. Compile locally without package installation, generated scripts/plugins, arbitrary paths, environment/file reads, or source maps.
  5. Maintain valid and malicious corpora including resource bombs and fabricated IDs.
- **Validate:** valid adaptive UI, all prohibited constructs, type/manifest/complexity/theme/a11y failures, and compiler isolation.

### P04-F04 Isolated renderer and readiness

- **Tools:** sandboxed Chromium surface, CSP, typed `postMessage`, error boundaries, Playwright tests.
- **Depends on:** P04-F01/F03 interface.
- **Concurrency:** parallel, then integrate after artifact shape stabilizes.
- **Build steps:**
  1. Render only validated artifacts in an origin-isolated sandbox with no Node/Electron/preload, network, navigation/forms/downloads/popups, storage, clipboard, permissions, or raw-source evaluation.
  2. Supply display-safe plan-derived props. Generated code cannot replace the trusted generated label, sources/coverage, controls, or fallback.
  3. Bridge only ready, resize, focus, and telemetry. Validate origin/channel/ownership/digests/revision/sequence/rate/size. Add no action or website-command channel.
  4. Open the resizable context pane, mount, and wait for the valid instance-bound ready handshake. Registration/load-start/model success is not readiness. Destroy failed, expired, navigated, hung, or violating surfaces.
  5. Preserve chat, ~45% default width, close/reopen, focus/keyboard, reduced motion, and 800x600 support.
- **Validate:** real readiness/timeout, automatic pane, isolation/CSP denials, forged/stale messages, recovery/cleanup, resizing, focus, and compact layout.

### P04-F05 End-to-end completion

- **Tools:** fixed pipeline, integration and Playwright visual/accessibility tests.
- **Depends on:** P04-F01–F04 and Phase 3.
- **Concurrency:** sequential integration.
- **Build steps:**
  1. Compose exactly: source finding → ordered Playwright captures → UI planning → UI generation → validation/typecheck/compile → registration → mount → ready handshake.
  2. Stream bounded stage progress, never HTML/plans/TSX/prompts/compiler/private state.
  3. Return `ready` only after handshake with opaque references/safe metadata. On any terminal failure return `failed` and remove partial UI.
  4. Append the safe result to chat; verify one short ready confirmation on success and no readiness claim on failure.
  5. Test comparison, grid, dashboard, article, gallery, schedule, and unfamiliar mixed layouts generated from plans rather than hardcoded templates.
  6. Enforce one execution and one visible instance per successful turn; cancellation/replacement tears down incomplete work.
- **Validate:** full request-to-ready flow, exact order/role isolation, no internal tools, multi-site fidelity, adaptive layouts, malicious rejection, truthful failures, visuals, and accessibility.

## Phase validation

Run contracts, adapters, compiler/security, sandbox/bridge, Phase 3–4 integration with multiple sites and partial failure, packaged-desktop pane tests, visual/a11y checks, typecheck, lint, build, and golden regressions.

## Phase acceptance

The chat model calls only `ui.generate`. Fixed code runs source finding, Playwright capture, planning, UI generation, validation, and isolated rendering. Only the trusted ready handshake returns `ready`; the chat model then tells the user the UI is ready. No additional model-callable tool or model-directed stage exists.
