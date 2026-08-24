# Phase 5 — Gated Action Execution

## Mission

Add form actions and approved direct API mutations in sandboxes/test accounts, always behind policy evaluation and exact user confirmation when sensitive or irreversible. Default deny live-site mutation.

## Claude execution restriction

Claude must not create, spawn, delegate to, or use subagents while executing this prompt. Claude must perform all work directly in the primary agent context. This restriction overrides every subagent or agent-based concurrency instruction in this prompt.

## Isolation rule

Read only the requirements, `Claude.md`, this prompt, relevant code/docs, and approved test-site records. Do not read any other implementation prompt. Tell subagents the same.

## Feature builds

### P05-F01 Action and sensitivity policy engine

- **Tools:** versioned policy-as-code/YAML, Zod/Pydantic, unit/property tests.
- **Depends on:** canonical contract and pilot governance.
- **Concurrency:** parallel with P05-F02, P05-F03, and P05-F04 using subagents.
- **Build steps:**
  1. Define a canonical `ActionIntent` containing fixed action kind, site/target, method/effect, material typed parameters, reversibility, data categories, account handle, and provenance; do not accept free-form policy flags from the model.
  2. Create versioned policy files under `config/action-policies/` with precedence for global deny, sensitive domain, site, action kind, and parameter rules; validate/lint them at startup and CI.
  3. Implement a pure policy evaluator in both schema boundary and server policy module that returns `allow`, `confirm`, or `deny` plus rule ID/version, normalized risk labels, human-readable reason key, and confirmation fields.
  4. Treat missing fields, unknown action kinds/sites, ambiguous target/effect, credential material, and policy load errors as deny; require confirmation for all mutations initially even if future policy could permit a narrow safe class.
  5. Store the normalized action and decision digest in an append-only audit interface without sensitive values, and add a table-driven corpus spanning payments, accounts, messages, submissions, reads, and deceptive descriptions.
- **Validate:** decision table, boundary/property tests, known false-positive/negative corpus, policy-version auditability, and default-deny tests.

### P05-F02 Confirmation capability flow

- **Tools:** signed short-lived server tokens, React confirmation UI, server-side state store, Vitest/Playwright.
- **Depends on:** canonical contract; consume P05-F01 output at integration.
- **Concurrency:** parallel with P05-F01/F03/F04.
- **Build steps:**
  1. Define `ConfirmationRequest` and `ConfirmationDecision` contracts with action digest, display-safe site/account/target/effect/parameters, risk labels, policy version, creation/expiry, and correlation IDs.
  2. Build the confirmation panel as a blocking decision card with explicit Confirm and Cancel, no preselected choice, clear irreversible/payment/message wording, accessible focus management, and a visible expiry countdown/status.
  3. On confirm, call a same-origin server endpoint that reloads the pending action, authenticates user/session, compares its digest and current policy, then creates a cryptographically random single-use capability stored server-side with TTL and consumed state.
  4. Return only the opaque capability ID to the coordinator; bind its record to user, session, site, exact action digest, policy version, and expiry. Never encode sensitive action data in a client-readable token.
  5. Cancel/expiry deletes or marks the pending record; any target/parameter/policy change invalidates it and creates a new confirmation request. Consume atomically immediately before execution to prevent double submission.
- **Validate:** tamper, replay, expiry, cross-user/session, stale parameters, double-click, cancel, and accessibility tests.

### P05-F03 UI form-action executor

- **Tools:** Nodriver/CDP, stable selectors, local staging site, pytest.
- **Depends on:** browser lifecycle.
- **Concurrency:** parallel with P05-F01/F02/F04; build against inert local forms only.
- **Build steps:**
  1. Add a closed action-plan schema under the browser service with navigation precondition, fill/select/check/click steps, stable semantic selector candidates, expected element role/text/origin, and postcondition; omit arbitrary JavaScript execution.
  2. Implement primitives that locate elements by deterministic semantic attributes, require exactly one visible enabled match, verify current origin and form ownership, and redact field values from logs/evidence.
  3. Add a dry-run resolver that loads the page, resolves every target, reports the exact planned effect, and makes no DOM mutation; feed this resolved plan into the policy/confirmation digest.
  4. At execution, reload/verify origin and preconditions, consume the matching capability, apply steps sequentially with cancellation checks, and require a second target verification immediately before the final submit click.
  5. Capture bounded sanitized before/after DOM assertions and optional redacted screenshots, evaluate postconditions, and return `succeeded`, `failed`, or `unknown` without automatically retrying a possibly submitted action.
- **Validate:** safe local forms, changed DOM, ambiguous selector refusal, cancellation, partial failure/recovery, and proof no submit occurs without valid capability.

### P05-F04 Direct API mutation executor

- **Tools:** httpx, approved endpoint mappings, request signing/session held inside browser service, pytest mock server.
- **Depends on:** P03-F04.
- **Concurrency:** parallel with P05-F01–F03 using test endpoints.
- **Build steps:**
  1. Extend endpoint governance with a separately reviewed mutation operation containing fixed method/path, request schema, response/postcondition schema, idempotency support, sensitivity, and explicit enabled flag; keep all entries disabled by default.
  2. Build an API action plan from typed logical parameters, validate it, resolve the final URL internally, and create a redacted preview/digest containing material effects but no session headers or credential values.
  3. After policy and confirmation, revalidate active site policy/map/schema and atomically consume the capability; construct the request inside the browser service using internal session state and a generated idempotency key when supported.
  4. Apply strict origin/redirect/time/rate/body limits, never retry a mutation unless the endpoint guarantees idempotency, and classify connection loss after send as `unknown` pending safe verification.
  5. Validate the response and perform a read-only postcondition check where possible; store a redacted audit event with operation/map/policy versions, idempotency hash, timing, and outcome.
- **Validate:** allowed/blocked endpoints, duplicate submission, timeouts/uncertain outcome, response drift, redaction, and missing confirmation capability.

### P05-F05 Policy-gated action coordinator and red team

- **Tools:** orchestrator, immutable audit events, Playwright/pytest end-to-end, adversarial fixtures.
- **Depends on:** P05-F01–F04.
- **Concurrency:** integrate after dependencies; run UI and API scenario suites concurrently.
- **Build steps:**
  1. Implement an orchestrator action state machine with persisted states `planned`, `policy_denied`, `awaiting_confirmation`, `confirmed`, `executing`, `succeeded`, `failed`, `unknown`, and `cancelled`, allowing only explicit transitions.
  2. Convert model tool calls into the canonical action intent, obtain a dry-run resolved plan from the chosen executor, evaluate policy server-side, and stream the immutable confirmation request when required.
  3. Pause the model/tool loop while confirmation is pending; on approval reload the action, current policy/site/map/session state, compare all digests/versions, consume capability, and dispatch only through the fixed executor registry.
  4. Verify the postcondition, append sanitized evidence/audit references, and tell the model/user the precise outcome; for `unknown`, prohibit blind retry and offer only a safe read-only status check or manual inspection.
  5. Add end-to-end local UI and mock-API scenarios plus adversarial variants where page text, images/metadata, model arguments, client commands, origins, or stale confirmations attempt to alter/bypass the action.
- **Validate:** sandbox/test accounts only; safe-action suite; confirmation precision metrics; hidden text, image-instruction metadata, look-alike URL, cross-origin, and prompt-injection tests; tracked failure rate.

## Phase acceptance

No live mutation without explicit human site approval. Every executed mutation has a matching policy decision, unexpired action digest, confirmation, and redacted audit trail.
