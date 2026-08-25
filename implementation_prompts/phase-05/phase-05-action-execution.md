# Phase 5 — Gated Action Execution

## Mission

Execute adaptive multi-step website workflows by letting Mistral compose a comprehensive predefined primitive set over Phase 3 opaque page, element, form, field, record, and interaction-capability handles. Plans are generative; executable primitives and authority are closed, schema-validated, policy-gated, incrementally executed against fresh page observations, and verified. Do not discover or invoke website APIs. Use sandboxes/test accounts, require exact confirmation when sensitive or irreversible, and default deny live-site mutation.

## Claude execution restriction

Claude must not create, spawn, delegate to, or use subagents while executing this prompt. Claude must perform all work directly in the primary agent context. This restriction overrides every subagent or agent-based concurrency instruction in this prompt.

## Isolation rule

Read only the requirements, `Claude.md`, this prompt, relevant code/docs, and approved test-site records. Do not read any other implementation prompt. Tell subagents the same.

## Feature builds

### P05-F01 Action and sensitivity policy engine

- **Tools:** versioned policy-as-code/YAML, Zod/Pydantic, unit/property tests.
- **Depends on:** canonical contract and pilot governance.
- **Concurrency:** parallel with P05-F02, P05-F03, P05-F04, and P05-F05 using subagents.
- **Build steps:**
  1. Define a canonical `ActionIntent` containing fixed action primitive, semantic intent, opaque Phase 3 observation/capability/element/form/field/record handles, material typed parameters or vault references, expected effect, reversibility, data categories, account handle, provenance, workflow ID, step ID, and retry semantics; do not accept free-form policy flags, raw URLs, HTTP methods, headers, selectors, cookies, credentials, or executable code from the model or client.
  2. Create versioned policy files under `config/action-policies/` with precedence for global deny, sensitive domain, site, action kind, and parameter rules; validate/lint them at startup and CI.
  3. Implement a pure policy evaluator in both schema boundary and server policy module that returns `allow`, `confirm`, or `deny` plus rule ID/version, normalized risk labels, human-readable reason key, and confirmation fields.
  4. Treat missing fields, unknown action kinds/sites, ambiguous target/effect, credential material, and policy load errors as deny; require confirmation for all mutations initially even if future policy could permit a narrow safe class.
  5. Store the normalized action and decision digest in an append-only audit interface without sensitive values, and add a table-driven corpus spanning payments, accounts, messages, submissions, reads, and deceptive descriptions.
- **Validate:** decision table, boundary/property tests, known false-positive/negative corpus, policy-version auditability, and default-deny tests.

### P05-F02 Comprehensive action primitive registry

- **Tools:** canonical Zod/JSON Schema contracts, generated Pydantic models, fixed executor registry, capability metadata, contract/property tests.
- **Depends on:** P05-F01 draft and Phase 3 `PageUnderstanding` plus interaction-capability handles.
- **Concurrency:** parallel with P05-F03, P05-F04, and P05-F05; owns primitive contracts and registry only.
- **Build steps:**
  1. Define a closed, versioned primitive union. Include at minimum: `observe_page`, `observe_region`, `read_element`, `read_form`, `read_table`, `read_collection`, `read_dialog`, `read_status`, `navigate_to_capability`, `go_back`, `go_forward`, `reload`, `refresh_page_state`, `paginate`, `search_within_site`, `select_record`, `expand_section`, `collapse_section`, `open_tab`, `open_menu`, `close_overlay`, `advance_carousel`, `focus_element`, `hover_element`, `scroll_element_into_view`, `scroll_container`, `fill_text`, `fill_email`, `fill_phone`, `fill_address_reference`, `fill_date`, `fill_date_range`, `fill_time`, `fill_number`, `fill_currency_amount`, `select_option`, `select_combobox_option`, `toggle_checkbox`, `choose_radio`, `set_range`, `upload_vault_file`, `clear_field`, `activate_control`, `submit_form`, `reset_form`, `play_media`, `pause_media`, `seek_media`, `wait_for_condition`, `verify_page_state`, `verify_url`, `verify_text`, `verify_field_state`, `verify_record_state`, `verify_price`, `verify_availability`, `request_user_input`, `request_confirmation`, `request_authentication`, `solve_by_user`, `handoff_live_website`, `return_from_handoff`, `cancel_workflow`, and `finish_workflow`.
  2. Give every primitive a strict argument/result schema, required Phase 3 handle type, observation-digest precondition, allowed site/origin relationship, local/external effect classification, sensitivity inputs, repeat/retry behavior, timeout, postcondition requirements, and safe failure states. Split a primitive when these security semantics differ; never add a generic `execute`, arbitrary HTTP, arbitrary JavaScript, raw CDP, shell, or free-form selector primitive.
  3. Reuse or extend server-issued opaque handle types for observation, browser session, page, origin, region, element, control, form, field, option, record, collection, dialog, media, file-vault object, stored user-data reference, generated-UI selection, confirmation capability, and live-view continuation. Bind every handle to user/session/workflow/site, page identity, observation digest, provenance, issuance state, expiry, and permitted primitive classes.
  4. Allow Mistral to generate new plans and semantic intents by composing registered primitives, but reject invented primitive names, forged handles, client/model-provided authority, and any plan step that cannot resolve to a currently available capability. A model-proposed novel action may be explained or mapped to existing primitives, never executed merely because it appears in JSON.
  5. Build request-scoped tool exposure so Mistral receives only primitives and handles applicable to the current workflow state. Use concise shared schemas and capability summaries to control context size while retaining full server-side validation.
  6. Add a registry completeness matrix covering search, comparison, account login handoff, scheduling, travel selection, carts, checkout, messaging, file upload, profile changes, reservation, purchase, cancellation, and result verification; missing capability must produce a typed unsupported/handoff result rather than unsafe improvisation.
- **Validate:** schema generation/roundtrip, unknown primitive/handle rejection, capability-scope isolation, primitive security metadata completeness, no arbitrary execution escape hatch, and coverage matrix tests.

### P05-F03 Confirmation and scoped preauthorization capability flow

- **Tools:** signed short-lived server tokens, React confirmation UI, server-side state store, Vitest/Playwright.
- **Depends on:** canonical contract; consume P05-F01 output at integration.
- **Concurrency:** parallel with P05-F01, P05-F02, P05-F04, and P05-F05.
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
- **Concurrency:** parallel with P05-F01, P05-F02, P05-F03, and P05-F05; build against inert local forms only.
- **Build steps:**
  1. Implement the DOM/UI subset of the primitive registry using server-issued semantic element/form/field/option handles with navigation preconditions and postconditions. Selector candidates remain server-side; omit arbitrary JavaScript execution and model/client-provided selectors.
  2. Implement primitives that locate elements by deterministic semantic attributes, require exactly one visible enabled match, verify current origin and form ownership, and redact field values from logs/evidence.
  3. Add a dry-run resolver that re-observes the current page, resolves every handle against semantic identity and ownership, reports the exact planned effect, and makes no DOM mutation; feed the fresh observation/action digest into policy and confirmation.
  4. At execution, reload/verify origin and preconditions, consume the matching capability, apply steps sequentially with cancellation checks, and require a second target verification immediately before the final submit click.
  5. Capture bounded sanitized before/after DOM assertions and optional redacted screenshots, evaluate postconditions, and return `succeeded`, `failed`, or `unknown` without automatically retrying a possibly submitted action.
- **Validate:** safe local forms, changed DOM, ambiguous selector refusal, cancellation, partial failure/recovery, and proof no submit occurs without valid capability.

### P05-F05 Capability-bound website control executor

- **Tools:** Nodriver/CDP input and navigation primitives, Phase 3 semantic handles, fresh page observation, local stateful test site, pytest.
- **Depends on:** P03-F04, P05-F01, and P05-F02.
- **Concurrency:** parallel with P05-F03 and P05-F04 using disjoint executor files and local fixtures.
- **Build steps:**
  1. Implement non-form website primitives for navigation links, buttons, disclosures, tabs, menus, dialogs, carousels, pagination, collection selection, scrolling, focus/hover, and bounded media controls. Every operation accepts an opaque Phase 3 capability/element handle and expected observation digest, never a selector, raw destination, event script, or arbitrary input command.
  2. Immediately before execution, re-observe the owning region and resolve the handle using server-held semantic identity, role/name, relationships, origin, visibility, enabled state, and structural context. Reject stale, ambiguous, missing, cross-session, cross-origin, or materially changed targets and return a typed replan requirement.
  3. Perform a dry run that classifies the current control effect and produces a redacted preview/digest. Unknown, mislabeled, download/upload, external-application, permission, authentication, communication, reservation, purchase/payment, account, destructive, or otherwise consequential controls must enter policy/confirmation or live-view handoff before activation.
  4. Execute through the narrowest CDP/browser primitive with cancellation, rate, timeout, popup, download, permission, and origin-transition interception. Do not call page APIs directly, dispatch arbitrary JavaScript events, bypass disabled controls, or synthesize actions against elements not represented in the fresh observation.
  5. Re-observe after each activation, compare before/after graph and URL/origin state, validate the declared postcondition, issue new handles for the new observation, and return `succeeded`, `failed`, `unknown`, `navigation`, `authentication_required`, `confirmation_required`, or `handoff_required`. Never retry an externally consequential activation automatically.
  6. Record only action/capability/observation/policy versions, redacted effect classification, timing, and outcome. Keep selectors, field values, screenshots, private DOM, cookies, and credentials out of results, model context, and audit events.
- **Validate:** link navigation, tabs, menus, dialog open/close, pagination, carousel, scrolling, media controls, stale/ambiguous handles, mislabeled destructive controls, popup/download/permission interception, origin changes, uncertain outcomes, redaction, and proof that no API invocation path exists.

### P05-F06 Adaptive workflow planner, coordinator, and red team

- **Tools:** orchestrator, immutable audit events, Playwright/pytest end-to-end, adversarial fixtures.
- **Depends on:** P05-F01 through P05-F05.
- **Concurrency:** integrate after dependencies; run form, control, and workflow scenario suites concurrently in isolated local fixtures.
- **Build steps:**
  1. Implement a persisted workflow state machine with states `intent_received`, `observing`, `planning_next_step`, `policy_denied`, `awaiting_user_input`, `awaiting_authentication`, `awaiting_confirmation`, `ready`, `executing`, `verifying`, `replanning`, `handoff_required`, `succeeded`, `failed`, `unknown`, and `cancelled`, allowing only explicit transitions and retaining completed-step/postcondition summaries.
  2. On an external generated-UI command, treat the Phase 4 Mistral-generated React surface as untrusted. Validate sandbox channel/origin, UI instance ownership, compiled-artifact/input/prompt/model/toolchain/source-observation digests, revision, message sequence/rate, command schema, and opaque capability ID, then reconstruct trusted context server-side from the original goal, selected record, Phase 3 graph/source/capability provenance, bounded declared UI state delta, browser/workflow state, completed actions, authorization scope, and currently available primitives. Never accept executable code, a rendered component tree, raw website target, or embedded prompt as action context.
  3. Ask Mistral for the next bounded primitive or a short revisable plan, validate every proposed step against the primitive registry and fresh Phase 3 handles, dry-run the immediate step, evaluate policy, and execute at most the safe contiguous prefix. Re-observe and replan after every navigation, control activation, form change/submission, unexpected content, changed availability/price, authentication, or any result that changes available capabilities.
  4. Pause while user input, authentication, confirmation, CAPTCHA, or manual resolution is pending. On continuation reload workflow, UI instance, policy, site/session/page state, current observation, handles, preauthorization, and digests; dispatch only through the fixed executor registry.
  5. Treat checkout and other goals as multi-step observed website workflows rather than one control activation. A click, submission, status message, or redirect is an intermediate observation until explicit postconditions prove the requested outcome; detect private-data/authentication pages and emit a Phase 6 handoff when automated continuation lacks authority or safe capabilities.
  6. Verify every consequential step through an independent fresh Phase 3 page/region/status/URL observation, append sanitized evidence/audit references, and report exact outcome to Mistral and the user. For `unknown`, prohibit blind retry and offer only safe re-observation or manual inspection.
  7. Let deterministic internal generated-UI interactions bypass Mistral, and let simple approved website capability commands execute deterministically when their fresh handle, classification, and arguments are complete. Use Mistral for ambiguous selection, cross-site reasoning, planning, recovery, and multi-step workflows rather than for every control activation.
  8. Add end-to-end accommodation scenarios covering multi-provider comparison, listing selection, details retrieval, price change, room choice, login handoff, checkout requiring private fields, scoped preauthorization, final confirmation, successful booking verification, unavailable inventory, CAPTCHA, and unknown-after-submit. Add unrelated scheduling and retail scenarios to prove the planner is not hotel-specific, plus adversarial page/model/client attempts to invent primitives, forge handles, or expand authority.
- **Validate:** sandbox/test accounts only; safe-action suite; confirmation precision metrics; stale observation/handle recovery; hidden text, image/SVG/media-instruction metadata, mislabeled controls, look-alike URL, cross-origin, and prompt-injection tests; tracked failure rate; no endpoint/API executor.

## Phase acceptance

No live mutation without explicit human site approval. Every executed website mutation has a matching fresh page observation, valid capability handle, policy decision, unexpired action digest, confirmation or valid narrowly scoped preauthorization, verified postcondition, and redacted audit trail; payment, irreversible submission, cancellation penalty, material price change, or scope expansion always receives fresh confirmation. Acceptance must prove that a novel workflow can be generated from predefined primitives without site-specific executable code, API discovery/invocation, or a generic execution escape hatch.
