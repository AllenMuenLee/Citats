# Phase 3 — API Discovery Layer

## Mission

On manually approved pilot sites, observe XHR/fetch traffic, redact it, infer stable endpoint templates, and expose strictly read-only callable mappings. Do not execute state-changing requests.

## Isolation rule

Use only the requirements, `Claude.md`, this prompt, relevant source, feature docs, and approved-site review records. Never read other implementation prompts. Tell subagents likewise.

## Feature builds

### P03-F01 Network interception and redaction

- **Tools:** Chrome DevTools Protocol through Nodriver, Pydantic, pytest, HAR-like sanitized fixtures.
- **Depends on:** P02-F01.
- **Concurrency:** parallel with P03-F02 and P03-F03 via subagents.
- **Build steps:**
  1. Create `services/browser/src/browser_service/network/` and subscribe to CDP request/response lifecycle events before navigation; correlate events using CDP request ID and task/session IDs.
  2. Retain only XHR/fetch metadata: method, normalized origin/path, status, timing, content type, initiator category, and bounded structural samples; skip websocket frames, media, fonts, and binary bodies.
  3. Run headers, query values, and JSON/form bodies through a default-deny redactor before constructing any persisted/logged object; remove cookies, authorization, CSRF/session tokens, known personal fields, and high-entropy secret candidates.
  4. Replace values with type/shape descriptors where endpoint inference needs structure, apply per-field/body/event caps, and attach redaction/truncation flags without retaining originals.
  5. Keep raw CDP events in task-local memory only until sanitized, clear them on completion/error, and expose only sanitized observations to the mapping layer.
- **Validate:** synthetic traffic coverage, redaction canaries, size limits, binary handling, same-origin tagging, and zero-secret snapshots.

### P03-F02 Endpoint inference and mapping store

- **Tools:** Python inference module, JSON Schema, Postgres or repository abstraction, pytest/property tests.
- **Depends on:** Phase 0 datastore seam and contract.
- **Concurrency:** parallel with P03-F01/F03 using sanitized fixtures.
- **Build steps:**
  1. Define repository models/migrations for site, endpoint map version, normalized operation, parameter schema, response schema, confidence, observation provenance, approval state, and last-seen timestamp; exclude raw secret/value columns.
  2. Normalize paths by origin and segments, then infer candidate variable segments only from repeated observations; distinguish query keys, optionality, primitive/array/object shapes, and stable headers without preserving sensitive values.
  3. Merge observations conservatively into method+origin+path-template groups, calculate confidence from repetition/shape consistency, and retain provenance pointers to sanitized observation IDs.
  4. Produce versioned immutable snapshots; compare a new snapshot with the active map for removed operations, status/content-type changes, and incompatible parameter/response shapes, then mark affected operations stale.
  5. Put storage behind an endpoint-map repository interface with in-memory and Postgres implementations and make map activation a separate, auditable operation rather than automatic inference.
- **Validate:** deterministic inference, parameter generalization, false-merge/split fixtures, schema validation, repeat-run stability, and drift alerts.

### P03-F03 Pilot-site governance

- **Tools:** YAML allowlist, policy validation, policy tests.
- **Depends on:** Phase 0 secure service boundary.
- **Concurrency:** parallel with P03-F01/F02.
- **Build steps:**
  1. Define a strict schema for `config/sites/<site-id>.yaml` containing canonical domains, allowed subdomains/routes/methods, discovery/replay permissions, data classification/retention, owner, reviewer, decision, dates, and kill-switch state.
  2. Implement a policy loader with schema validation, IDN/domain normalization, exact route/method matching, cached reads with bounded TTL, and an emergency disable override checked on every capture and invocation.
  3. Add startup/CI linting that rejects duplicate site IDs, overly broad wildcards, unsafe methods in this phase, invalid dates, and committed credentials; log only site ID, policy version, and decision.
  4. Seed only a local fixture-site policy as approved; create real pilot records as `pending` unless a human supplies and signs the review decision.
- **Validate:** missing/expired approval blocks capture and replay; only safe HTTP methods are permitted; policy files lint against schema.

### P03-F04 Read-only discovered API invoker

- **Tools:** httpx within browser-service session boundary, SSRF controls, schema validator, integration tests.
- **Depends on:** P03-F01, P03-F02, P03-F03.
- **Concurrency:** integrate after dependencies.
- **Build steps:**
  1. Create an invocation service that loads an active non-stale endpoint map and current site policy, verifies confidence threshold, and materializes a tool definition only for approved `GET`/`HEAD` operations.
  2. Accept typed logical parameters rather than arbitrary URLs/headers; expand them into the approved template, revalidate the final URL against origin/route/DNS policy, and reject undeclared keys.
  3. Execute through an httpx client owned by the browser-service session boundary, copying only explicitly approved internal session headers/cookies and never serializing them into request logs, tool results, or errors.
  4. Enforce connect/read/total timeouts, response/content-type/body limits, per-site rate limits, redirect revalidation, and cancellation; validate successful response shapes against the map and mark drift instead of coercing mismatches.
  5. Transform responses into bounded, redacted structured data plus provenance/map version/freshness, register the generated read-only tools with the orchestrator, and return typed policy/stale/drift failures.
- **Validate:** local pilot fixtures, forbidden method/origin tests, replay equivalence to observed response, stale-map failure, redaction, endpoint coverage and repeated-run stability metrics.

## Phase acceptance

Use a local replica or human-approved pilot only. No POST/PUT/PATCH/DELETE execution is accepted in this phase.
