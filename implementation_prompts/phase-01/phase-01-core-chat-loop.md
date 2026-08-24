# Phase 1 — Core Chat Loop

## Mission

This phase runs inside the Electron desktop application. Next.js is the renderer, not a publicly deployed website.

Deliver a streaming Mistral conversation with in-memory session context and a deterministic, validated tool-calling loop using only stub tools. No web browsing.

## Claude execution restriction

Claude must not create, spawn, delegate to, or use subagents while executing this prompt. Claude must perform all work directly in the primary agent context. This restriction overrides every subagent or agent-based concurrency instruction in this prompt.

## Isolation rule

Read the requirements, `docs/desktop-architecture-and-ui-specification.md`, `Claude.md`, this prompt, relevant source files, and Phase 0 feature docs as needed. **Do not read other implementation prompts.** Apply this rule to subagents.

## Feature builds

### P01-F01 Mistral provider adapter

- **Tools:** Mistral official SDK/API, Vercel AI SDK provider interface, Zod, mocked HTTP tests.
- **Depends on:** P00-F03 contract.
- **Concurrency:** parallel with P01-F02 and P01-F03 via subagents.
- **Build steps:**
  1. Create `apps/renderer/src/server/ai/mistral/` with a provider factory that reads and validates model name, API base URL, timeout, and API-key presence on the trusted local server side only; fail startup with a non-secret configuration message.
  2. Implement an adapter exposing one internal interface for streamed text deltas, tool-call deltas, usage, finish reason, and provider request ID so the orchestrator never depends directly on SDK response objects.
  3. Assemble SDK requests from trusted system instructions and bounded conversation turns, forward `AbortSignal`, apply timeout, and retry only pre-stream transient/rate-limit failures with bounded jitter; never replay after user-visible output begins.
  4. Map authentication, rate limit, timeout, malformed response, safety refusal, and provider outage into stable application error codes with user-safe messages.
  5. Emit duration, time-to-first-token, token counts, attempt count, and error code metrics keyed by correlation ID; keep prompt/message bodies out of logs and metric labels.
- **Validate:** mocked streaming, rate-limit/auth/timeout behavior, abort propagation, and structured tool-call parsing.

### P01-F02 Chat interface

- **Tools:** Next.js App Router, React, Vercel AI SDK UI hooks, Testing Library, accessibility tooling.
- **Depends on:** Phase 0 desktop and renderer shells.
- **Concurrency:** parallel with P01-F01 and P01-F03.
- **Build steps:**
  1. Add the chat route and component boundary under `apps/renderer/src/app/` and `apps/renderer/src/components/chat/`; keep preload/local-server communication in a dedicated typed hook rather than inside presentation components.
  2. Define a UI message model for user, assistant, tool-status, and error parts with stable local IDs; render ordered parts incrementally without replacing already streamed content.
  3. Implement an autosizing composer with submit, Enter/Shift+Enter behavior, empty/oversize validation, disabled state during submission where required, and a stop button wired to request abort.
  4. Implement streaming, stopped, failed, and completed states; retry must create a new request from the same prior conversation boundary rather than duplicating the failed assistant turn.
  5. Generate one ephemeral session ID per desktop window, attach it to requests, and clear all state on reload/new-session action. Add ARIA live status without announcing every token and preserve focus after send/stop/retry.
- **Validate:** component tests, keyboard and screen-reader basics, stream interruption/retry, responsive smoke test.

### P01-F03 Conversation state and instruction policy

- **Tools:** TypeScript state module, Zod, unit tests.
- **Depends on:** P00-F03.
- **Concurrency:** parallel with P01-F01 and P01-F02.
- **Build steps:**
  1. Create `apps/renderer/src/server/conversation/` with domain types and an in-memory repository keyed by ephemeral session ID; expose append/read/clear through an interface that can later be replaced by persistence.
  2. Validate role, part type, length, sequence, and ownership on every append; generate server-side turn IDs and reject client attempts to insert system or tool-result roles.
  3. Implement deterministic context selection using configurable message/token estimates, always retaining system policy and the newest complete turns while dropping oldest complete turns only.
  4. Build system instructions from versioned server-owned fragments; wrap user/tool data in typed message parts with trust labels and never concatenate it into the system instruction string.
  5. Add a per-session active-request guard and define reject-or-queue behavior, attach correlation IDs to turns, and clean abandoned ephemeral sessions after a bounded TTL.
- **Validate:** ordering, context truncation, concurrent-request rejection/queue behavior, and untrusted-content boundary tests.

### P01-F04 Orchestrator tool loop

- **Tools:** Vercel AI SDK server primitives, canonical tool schemas, Vitest, stub bridge tool.
- **Depends on:** P01-F01, P01-F03; UI hookup also needs P01-F02.
- **Concurrency:** integrate after dependencies.
- **Build steps:**
  1. Create `apps/renderer/src/server/orchestrator/` with an explicit state machine for model request, tool validation, tool execution, result append, and final model response; set configurable maximum steps and total deadline.
  2. Register only the Phase 0 echo tool in a server-owned registry containing its model definition, canonical argument/result schemas, sensitivity, and executor; reject unknown names before bridge dispatch.
  3. Accumulate streamed tool-call arguments until complete, validate once against the canonical schema, assign invocation/correlation IDs, and emit sanitized tool-start/progress/result events to the UI.
  4. Pass the same abort signal and remaining deadline through model and tool calls; on cancellation stop iteration, cancel the bridge request, and append no synthetic success result.
  5. Convert validation/execution failures into typed tool results that the model may explain, but immediately stop on policy/contract errors; prevent repeated identical calls and terminate at the step cap with a clear result.
  6. Expose the orchestrator through a server route that accepts only user text plus session ID, loads server-owned history, streams protocol events, and commits completed turns atomically.
- **Validate:** direct answer, one/multiple tool calls, malformed/unknown calls, repeated-loop cutoff, cancellation, latency benchmark, and instruction-following fixtures.

## Phase acceptance

Demonstrate a streaming direct reply and a stub-tool reply. Run unit, integration, type, lint, accessibility smoke, schema correctness, and latency tests. Confirm browsing endpoints cannot be invoked.
