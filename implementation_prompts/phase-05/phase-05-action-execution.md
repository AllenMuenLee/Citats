# Phase 5 — Gated Action Execution

## Mission

Execute adaptive multi-step external workflows by letting Mistral compose a comprehensive predefined capability set over dynamically discovered opaque targets. Plans are generative; executable primitives and authority are closed, schema-validated, policy-gated, incrementally executed, and verified. Use sandboxes/test accounts, require exact confirmation when sensitive or irreversible, and default deny live-site mutation.

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
  1. Define a canonical `ActionIntent` containing fixed action primitive, semantic intent, opaque site/target/operation handles, material typed parameters or vault references, expected effect, reversibility, data categories, account handle, provenance, workflow ID, step ID, and idempotency semantics; do not accept free-form policy flags, raw URLs, methods, headers, selectors, cookies, credentials, or executable code from the model or client.
  2. Create versioned policy files under `config/action-policies/` with precedence for global deny, sensitive domain, site, action kind, and parameter rules; validate/lint them at startup and CI.
  3. Implement a pure policy evaluator in both schema boundary and server policy module that returns `allow`, `confirm`, or `deny` plus rule ID/version, normalized risk labels, human-readable reason key, and confirmation fields.
  4. Treat missing fields, unknown action kinds/sites, ambiguous target/effect, credential material, and policy load errors as deny; require confirmation for all mutations initially even if future policy could permit a narrow safe class.
  5. Store the normalized action and decision digest in an append-only audit interface without sensitive values, and add a table-driven corpus spanning payments, accounts, messages, submissions, reads, and deceptive descriptions.
- **Validate:** decision table, boundary/property tests, known false-positive/negative corpus, policy-version auditability, and default-deny tests.

### P05-F02 Comprehensive action primitive registry

- **Tools:** canonical Zod/JSON Schema contracts, generated Pydantic models, fixed executor registry, capability metadata, contract/property tests.
- **Depends on:** P05-F01 draft and Phase 3 action-affordance handles.
- **Concurrency:** parallel with confirmation and executor builds; owns primitive contracts and registry only.
- **Build steps:**
  1. Define a closed, versioned primitive union. Include at minimum: `observe_page`, `read_element`, `read_form`, `read_table`, `read_status`, `navigate_safe`, `go_back`, `go_forward`, `reload`, `open_same_origin_target`, `invoke_read_only_operation`, `refresh_data`, `paginate`, `search_within_site`, `select_record`, `expand_section`, `focus_element`, `scroll_element_into_view`, `fill_text`, `fill_email`, `fill_phone`, `fill_address_reference`, `fill_date`, `fill_date_range`, `fill_number`, `fill_currency_amount`, `select_option`, `select_combobox_option`, `toggle_checkbox`, `choose_radio`, `upload_vault_file`, `clear_field`, `click_control`, `submit_form`, `invoke_approved_mutation`, `wait_for_condition`, `verify_dom`, `verify_url`, `verify_api_state`, `verify_price`, `verify_availability`, `request_user_input`, `request_confirmation`, `request_authentication`, `solve_by_user`, `handoff_live_website`, `return_from_handoff`, `cancel_workflow`, and `finish_workflow`.
  2. Give every primitive a strict argument/result schema, required target-handle type, preconditions, allowed site/origin relationship, read/mutation classification, sensitivity inputs, idempotency/retry behavior, timeout, postcondition requirements, and safe failure states. Split a primitive when these security semantics differ; never add a generic `execute`, arbitrary HTTP, arbitrary JavaScript, raw CDP, shell, or free-form selector primitive.
  3. Define server-issued opaque handle types for browser session, page, origin, element, form, field, option, record, operation, file-vault object, stored user-data reference, generated-UI selection, confirmation capability, and live-view continuation. Bind every handle to user/session/workflow/site, provenance, issuance state, expiry, and permitted primitive classes.
  4. Allow Mistral to generate new plans and semantic intents by composing registered primitives, but reject invented primitive names, forged handles, client/model-provided authority, and any plan step that cannot resolve to a currently available capability. A model-proposed novel action may be explained or mapped to existing primitives, never executed merely because it appears in JSON.
  5. Build request-scoped tool exposure so Mistral receives only primitives and handles applicable to the current workflow state. Use concise shared schemas and capability summaries to control context size while retaining full server-side validation.
  6. Add a registry completeness matrix covering search, comparison, account login handoff, scheduling, travel selection, carts, checkout, messaging, file upload, profile changes, reservation, purchase, cancellation, and result verification; missing capability must produce a typed unsupported/handoff result rather than unsafe improvisation.
- **Validate:** schema generation/roundtrip, unknown primitive/handle rejection, capability-scope isolation, primitive security metadata completeness, no arbitrary execution escape hatch, and coverage matrix tests.

### P05-F03 Confirmation and scoped preauthorization capability flow

- **Tools:** signed short-lived server tokens, React confirmation UI, server-side state store, Vitest/Playwright.
- **Depends on:** canonical contract; consume P05-F01 output at integration.
- **Concurrency:** parallel with P05-F01/F03/F04.
- **Build steps:**
  1. Define `ConfirmationRequest` and `ConfirmationDecision` contracts with action digest, display-safe site/account/target/effect/parameters, risk labels, policy version, creation/expiry, and correlation IDs.
  2. Build the confirmation panel as a blocking decision card with explicit Confirm and Cancel, no preselected choice, clear irreversible/payment/message wording, accessible focus management, and a visible expiry countdown/status.
  3. On confirm, call a same-origin server endpoint that reloads the pending action, authenticates user/session, compares its digest and current policy, then creates a cryptographically random single-use capability stored server-side with TTL and consumed state.
  4. Return only the opaque capability ID to the coordinator; bind its record to user, session, site, exact action digest, policy version, and expiry. Never encode sensitive action data in a client-readable token.
  5. Cancel/expiry deletes or marks the pending record; any target/parameter/policy change invalidates it and creates a new confirmation request. Consume atomically immediately before execution to prevent double submission.
  6. Define optional user preauthorization as a server-owned, revocable, expiring scope over exact sites, action classes, accounts, data categories, date ranges, amount/currency ceilings, and workflow purpose. Re-evaluate it before every step; never treat broad phrases such as "complete checkout for me" as unlimited authority, and always require fresh confirmation for payment, irreversible booking/submission, cancellation penalties, price increases, changed recipient, or scope expansion.
- **Validate:** tamper, replay, expiry, cross-user/session, stale parameters, double-click, cancel, and accessibility tests.

### P05-F04 UI form-action executor

- **Tools:** Nodriver/CDP, stable selectors, local staging site, pytest.
- **Depends on:** browser lifecycle.
- **Concurrency:** parallel with P05-F01/F02/F04; build against inert local forms only.
- **Build steps:**
  1. Implement the DOM/UI subset of the primitive registry using server-issued semantic element/form/field/option handles with navigation preconditions and postconditions. Selector candidates remain server-side; omit arbitrary JavaScript execution and model/client-provided selectors.
  2. Implement primitives that locate elements by deterministic semantic attributes, require exactly one visible enabled match, verify current origin and form ownership, and redact field values from logs/evidence.
  3. Add a dry-run resolver that loads the page, resolves every target, reports the exact planned effect, and makes no DOM mutation; feed this resolved plan into the policy/confirmation digest.
  4. At execution, reload/verify origin and preconditions, consume the matching capability, apply steps sequentially with cancellation checks, and require a second target verification immediately before the final submit click.
  5. Capture bounded sanitized before/after DOM assertions and optional redacted screenshots, evaluate postconditions, and return `succeeded`, `failed`, or `unknown` without automatically retrying a possibly submitted action.
- **Validate:** safe local forms, changed DOM, ambiguous selector refusal, cancellation, partial failure/recovery, and proof no submit occurs without valid capability.

### P05-F05 Direct API mutation executor

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

### P05-F06 Adaptive workflow planner, coordinator, and red team

- **Tools:** orchestrator, immutable audit events, Playwright/pytest end-to-end, adversarial fixtures.
- **Depends on:** P05-F01 through P05-F05.
- **Concurrency:** integrate after dependencies; run UI and API scenario suites concurrently.
- **Build steps:**
  1. Implement a persisted workflow state machine with states `intent_received`, `observing`, `planning_next_step`, `policy_denied`, `awaiting_user_input`, `awaiting_authentication`, `awaiting_confirmation`, `ready`, `executing`, `verifying`, `replanning`, `handoff_required`, `succeeded`, `failed`, `unknown`, and `cancelled`, allowing only explicit transitions and retaining completed-step/postcondition summaries.
  2. On an external generated-UI command, validate the UI instance/digest/revision and opaque action ID, then reconstruct trusted context server-side from the original goal, selected record, source/map provenance, bounded relevant UI state delta, browser/workflow state, completed actions, authorization scope, and currently available capabilities. Never send the rendered component tree or an embedded client prompt to Mistral.
  3. Ask Mistral for the next bounded primitive or a short revisable plan, validate every proposed step against the primitive registry and live handles, dry-run the immediate step, evaluate policy, and execute at most the safe contiguous prefix. Re-observe and replan after navigation, mutation, unexpected content, changed availability/price, authentication, or any result that changes available capabilities.
  4. Pause while user input, authentication, confirmation, CAPTCHA, or manual resolution is pending. On continuation reload workflow, UI instance, policy, site/map/session state, handles, preauthorization, and digests; dispatch only through the fixed executor registry.
  5. Treat checkout and other goals as multi-step workflows rather than one API call. A successful response or redirect is an intermediate observation until explicit postconditions prove the requested outcome; detect private-data/authentication pages and emit a Phase 6 handoff when automated continuation lacks authority or safe capabilities.
  6. Verify every consequential step through an independent read-only DOM/API/URL/status check where possible, append sanitized evidence/audit references, and report exact outcome to Mistral and the user. For `unknown`, prohibit blind retry and offer only safe status verification or manual inspection.
  7. Let deterministic internal UI interactions bypass Mistral, and let simple approved read-only external commands execute deterministically when their mapping and arguments are complete. Use Mistral for ambiguous selection, cross-site reasoning, planning, recovery, and multi-step workflows rather than for every click.
  8. Add end-to-end accommodation scenarios covering multi-provider comparison, listing selection, details retrieval, price change, room choice, login handoff, checkout requiring private fields, scoped preauthorization, final confirmation, successful booking verification, unavailable inventory, CAPTCHA, and unknown-after-submit. Add unrelated scheduling and retail scenarios to prove the planner is not hotel-specific, plus adversarial page/model/client attempts to invent primitives, forge handles, or expand authority.
- **Validate:** sandbox/test accounts only; safe-action suite; confirmation precision metrics; hidden text, image-instruction metadata, look-alike URL, cross-origin, and prompt-injection tests; tracked failure rate.

## Phase acceptance

No live mutation without explicit human site approval. Every executed mutation has a matching policy decision, unexpired action digest, confirmation or valid narrowly scoped preauthorization, and redacted audit trail; payment, irreversible submission, cancellation penalty, material price change, or scope expansion always receives fresh confirmation. Acceptance must prove that a novel workflow can be generated from predefined primitives without adding site-specific executable code or exposing a generic execution escape hatch.
