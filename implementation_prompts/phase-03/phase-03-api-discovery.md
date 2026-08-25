# Phase 3 — API Discovery Layer

## Mission

On public websites, attach sanitized network observation to the Phase 2 navigation lifecycle, infer stable endpoint templates and action affordances, and expose strictly read-only callable mappings to the orchestrator. Discovery must adapt to the user's goal and arbitrary public-site response shapes; it must not depend on a hard-coded hotel, product, or flight workflow. Do not execute state-changing requests or access private-network destinations.

## Claude execution restriction

Claude must not create, spawn, delegate to, or use subagents while executing this prompt. Claude must perform all work directly in the primary agent context. This restriction overrides every subagent or agent-based concurrency instruction in this prompt.

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

- **Tools:** YAML policy overrides, policy validation, policy tests.
- **Depends on:** Phase 0 secure service boundary.
- **Concurrency:** parallel with P03-F01/F02.
- **Build steps:**
  1. Define a strict schema for `config/sites/<site-id>.yaml` containing canonical domains, allowed subdomains/routes/methods, discovery/replay permissions, data classification/retention, owner, reviewer, decision, dates, and kill-switch state.
  2. Implement a policy loader with schema validation, IDN/domain normalization, optional exact route/method overrides, cached reads with bounded TTL, and an emergency disable override checked on every capture and invocation. Public websites without a policy record are enabled by default for read-only discovery and replay.
  3. Add startup/CI linting that rejects duplicate site IDs, overly broad wildcards, unsafe methods in this phase, invalid dates, and committed credentials; log only site ID, policy version, and decision.
  4. Seed a local fixture policy and permit unlisted public websites by default. Explicit site policies may narrow routes, disable discovery/replay, or activate a kill switch without being prerequisites for public-web access.
- **Validate:** unlisted public websites permit capture and read-only replay; explicit disable controls take precedence; only safe HTTP methods are permitted; policy files lint against schema.

### P03-F04 Read-only discovered API invoker

- **Tools:** httpx within browser-service session boundary, SSRF controls, schema validator, integration tests.
- **Depends on:** P03-F01, P03-F02, P03-F03.
- **Concurrency:** integrate after dependencies.
- **Build steps:**
  1. Create an invocation service that loads an active non-stale endpoint map, applies any site policy override, verifies confidence threshold, and materializes a tool definition only for `GET`/`HEAD` operations.
  2. Accept typed logical parameters rather than arbitrary URLs/headers; expand them into the discovered template, revalidate the final URL against origin/route/DNS policy, and reject undeclared keys.
  3. Execute through an httpx client owned by the browser-service session boundary, copying only explicitly approved internal session headers/cookies and never serializing them into request logs, tool results, or errors.
  4. Enforce connect/read/total timeouts, response/content-type/body limits, per-site rate limits, redirect revalidation, and cancellation; validate successful response shapes against the map and mark drift instead of coercing mismatches.
  5. Transform responses into bounded, redacted structured data plus provenance/map version/freshness, register the generated read-only tools with the orchestrator, and return typed policy/stale/drift failures.
- **Validate:** local pilot fixtures, forbidden method/origin tests, replay equivalence to observed response, stale-map failure, redaction, endpoint coverage and repeated-run stability metrics.

### P03-F05 Navigation-integrated adaptive discovery

- **Tools:** Phase 2 navigation observer hook, discovery service, endpoint-map repository, canonical contracts, orchestrator tool registry, Mistral tool loop, end-to-end fixtures.
- **Depends on:** P03-F01, P03-F02, P03-F03, P03-F04, and Phase 2 read-only browsing.
- **Concurrency:** integrate after dependencies.
- **Build steps:**
  1. Compose discovery with the real Phase 2 browser context and page. Attach CDP capture before `NavigationService.navigate`, keep it active through bounded client-render settling, and detach and clear raw state in `finally`; do not launch a second navigation merely to discover APIs.
  2. Add a trusted server-owned discovery mode to the browse operation or a separate `browser.navigate_extract_and_discover` tool with URL and bounded goal fields only. The model and renderer must not control CDP domains, capture filters, headers, cookies, raw requests, activation, or persistence policy.
  3. Return separate bounded `document` and `discovery` sections. The document contains Phase 2 evidence and affordances; discovery contains sanitized observation counts, candidate/active map versions, typed read-only operation handles, action-affordance descriptors, confidence, freshness, drift, and warnings. Never serialize raw captures, secrets, selectors, or authenticated values to Mistral.
  4. Correlate a visible DOM affordance with an observed request or safe navigation target only when supported by explicit provenance such as a stable link destination, initiator relationship, or controlled read-only fixture interaction. Label unsupported relationships as `unknown`; never claim that a search-page button is an executable checkout API merely because their labels or URLs appear related.
  5. Define a closed action-affordance contract with opaque `actionId`, semantic `intent`, site ID, source/listing/item handles, target class (`local_ui`, `read_only_operation`, `external_workflow`, or `live_website_handoff`), evidence references, confidence, and required future capability. It must contain no executable URL, method, headers, cookies, selector, prompt, or policy override.
  6. Save inferred maps as immutable candidates, conservatively auto-activate only policy-permitted, non-stale, high-confidence `GET`/`HEAD` operations, and keep navigation, interaction, and mutation affordances non-executable until their owning later phase. Record activation reason/version and retain a kill switch; never auto-activate a method whose safety is ambiguous.
  7. Persist active endpoint maps through the configured repository seam and refresh the request-scoped orchestrator catalog after discovery so newly active operations can be offered in the next model step without process restart. Scope definitions to the current user goal, sites, session, map versions, and policy rather than exposing the global catalog.
  8. Instruct Mistral to discover candidate sources with hosted Web Search, navigate and observe each selected public page, use returned read-only operations to gather complete comparable records, and reason over bounded results. The model may dynamically choose sites and operation sequences but may invoke only server-supplied tool definitions and opaque handles.
  9. Append every discovered-API result to Mistral as a canonical `tool` result and simultaneously emit the same validated result to the generative-UI transformer. Mark page/API content untrusted, preserve source/map/freshness provenance, and report partial provider failures without discarding successful providers.
  10. Add adaptive multi-site scenarios for accommodation search, retail comparison, travel schedules, and an unfamiliar generic-record site. Cover Web Search to URL discovery, concurrent safe navigation where resource limits permit, DOM/API merging, per-provider failure, map refresh, read-only replay, and proof that checkout/mutation is represented only as a future workflow intent.
- **Validate:** one navigation performs both extraction and capture; capture begins before navigation; candidate-to-active transitions are auditable; newly active scoped tools reach Mistral in the same task; structured results reach both Mistral and the UI boundary; unknown site shapes fall back to generic records/text; no raw request, credential, arbitrary URL, or mutation tool crosses the boundary.

## Phase acceptance

Public websites are enabled without individual approval. Private, loopback, link-local, reserved, multicast, and unspecified network destinations remain blocked except for the explicit local test fixture. No POST/PUT/PATCH/DELETE execution is accepted in this phase. A Phase 3 acceptance run must prove the complete Web Search -> navigate/extract/capture -> infer/activate -> scoped tool invocation -> Mistral plus generative-UI result flow.
