# Phase 4 — Generative UI Integration

## Mission

Render safe, accessible, task-specific React components from validated structured tool results for a narrow pilot set: product results and flight comparisons. No free-form model-generated code and no transaction execution.

## Claude execution restriction

Claude must not create, spawn, delegate to, or use subagents while executing this prompt. Claude must perform all work directly in the primary agent context. This restriction overrides every subagent or agent-based concurrency instruction in this prompt.

## Isolation rule

Read the requirements, `Claude.md`, this prompt, relevant source, and relevant feature docs only. Never read other implementation prompts. Repeat this constraint in every subagent task.

## Feature builds

### P04-F01 UI result protocol and registry

- **Tools:** Zod/JSON Schema, TypeScript discriminated unions, Vitest, contract fixtures.
- **Depends on:** P00-F03 and Phase 3 structured results.
- **Concurrency:** parallel with P04-F02, P04-F03, and P04-F04 via subagents.
- **Build steps:**
  1. Add a versioned `GenerativeUiPart` discriminated union to `packages/contracts/src/ui/` with `component_type`, `schema_version`, `props`, `provenance`, `allowed_commands`, `correlation_id`, and freshness/warning fields.
  2. Define separate strict prop schemas for each registered component; cap row/item/text sizes, require source references for externally derived values, and forbid HTML, scripts, callback source, style strings, and arbitrary component names.
  3. Create a server registry in `apps/renderer/src/server/generative-ui/` mapping component type/version to prop schema, command schema, result transformer, and text-fallback formatter.
  4. Create a client registry in `apps/renderer/src/components/generative-ui/registry.ts` mapping the same closed identifiers to statically imported React components; unknown identifiers must never trigger dynamic import/eval.
  5. Validate tool output server-side before streaming and again at the client boundary; on failure emit a typed warning plus escaped cited text fallback and record schema/version diagnostics.
- **Validate:** cross-language fixtures, unknown/version-mismatch rejection, payload bounds, provenance requirements, and fallback behavior.

### P04-F02 Product results component

- **Tools:** React, Vercel AI SDK streaming parts, Testing Library, Storybook or equivalent visual harness.
- **Depends on:** draft P04-F01 schema.
- **Concurrency:** parallel with P04-F03/F04 after schema draft; exclusive component files.
- **Build steps:**
  1. Define `ProductResultProps` with stable item ID, name, normalized price/currency, merchant, availability qualifier, image URL policy, comparable attributes, source IDs, retrieved time, and partial-data warnings.
  2. Implement pure normalization in the server transformer: preserve original currency, never compare missing/non-equivalent units silently, cap attributes/items, and produce a deterministic default sort without changing source values.
  3. Build `ProductResults` from semantic list/table primitives with compact/mobile layouts, visible source/freshness labels, empty/loading/error/partial states, safe images and external links, and no purchase control.
  4. Implement local sorting/filtering for already-loaded fields and emit typed read-only commands only when a server refresh/additional filter is needed; include current query state and component instance ID.
  5. Add fixture stories for one/many/partial/stale/mixed-currency products and tests for keyboard navigation, announcements, sorting stability, sanitization, link provenance, and narrow viewport behavior.
- **Validate:** schema-driven stories, interaction/a11y tests, partial/malformed data, responsive visual snapshots, source attribution.

### P04-F03 Flight comparison component

- **Tools:** same UI stack as P04-F02, timezone/currency-safe utilities.
- **Depends on:** draft P04-F01 schema.
- **Concurrency:** parallel with P04-F02/F04.
- **Build steps:**
  1. Define `FlightComparisonProps` for itinerary/leg IDs, airport codes, ISO timestamps with offsets, duration, stops, carriers, fare/currency, baggage/refund caveats, source IDs, retrieved time, and availability disclaimer.
  2. Add server normalization that validates leg ordering, calculates display durations/stops without discarding supplied offsets, keeps fare qualifiers, caps itineraries, and marks inconsistent or missing data rather than guessing.
  3. Build responsive summary cards plus expandable leg detail using semantic controls; display local offsets/time zones, total duration, stop locations, price caveats, source/freshness, and a persistent “verify availability” notice.
  4. Implement deterministic client sorting/filtering for price, duration, stops, and departure window; a selection only updates comparison state or emits a read-only detail command and must never invoke booking.
  5. Add multi-leg, overnight, DST, mixed-currency, missing-fare, stale, empty, and partial fixtures plus accessibility, interaction, timezone, snapshot, and provenance tests.
- **Validate:** multi-leg/timezone/currency fixtures, a11y, responsive visual QA, stale/partial data warnings, command validation.

### P04-F04 Command and provenance boundary

- **Tools:** typed server actions/API routes, CSRF protection, allowlist tests.
- **Depends on:** P04-F01 contract.
- **Concurrency:** parallel with component builds.
- **Build steps:**
  1. Define a `UiCommand` union keyed by registered component/command versions with component instance ID, originating result digest, typed arguments, correlation ID, and optional idempotency key.
  2. When streaming a component, store a short-lived server record containing user/session ownership, result digest, allowed commands, schemas, and provenance; send only the opaque instance ID to the browser.
  3. Add a same-origin POST handler that authenticates session, checks CSRF/origin, loads the instance, verifies expiry/ownership/digest/allowlist, validates arguments, and maps the command to a fixed internal read-only tool.
  4. Do not accept client-provided tool names, URLs, source records, or policy flags; reconstruct all trusted routing from the stored registry record and preserve original invocation/source IDs in the new result.
  5. Make repeated commands idempotent where applicable, rate-limit by session/instance, and return typed expired/stale/invalid-command results that let the UI refresh safely.
- **Validate:** tampering, replay/idempotency, CSRF, unknown commands, and provenance continuity tests.

### P04-F05 Stream integration and UX evaluation

- **Tools:** Vercel AI SDK UI stream, Playwright, visual snapshots, small usability protocol.
- **Depends on:** P04-F01–F04.
- **Concurrency:** integration step after dependencies.
- **Build steps:**
  1. Extend the chat stream protocol/parser to accept generative-UI parts interleaved with text/tool status, buffer incomplete JSON parts, and render a stable placeholder keyed by component instance ID.
  2. Connect validated parts to the client registry and the command endpoint; keep component state local, display command progress/errors, and replace or append results according to the server response relationship.
  3. Add error boundaries per generated component so rendering/interaction failures leave the rest of the conversation usable and expose the server-provided cited text fallback.
  4. Instrument only component type/version, render success, command type, latency, fallback reason, and optional consented clarity response—never raw result props, queries, or identifiers in analytics.
  5. Build Playwright flows from fixed product/flight tool fixtures covering streamed partial delivery, success, invalid schema/version, command expiry, keyboard use, narrow/wide layouts, and fallback comparison against plain text.
- **Validate:** end-to-end product/flight fixtures, schema mismatch fallback, visual QA range, keyboard/screen reader flows, and component clarity versus plain text.

## Phase acceptance

All structured output validates before rendering; arbitrary code cannot run; both pilot components pass visual, interaction, accessibility, provenance, and fallback tests.
