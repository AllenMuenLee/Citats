# Phase 8 — Guardrail Hardening

## Mission

Harden the complete system against indirect prompt injection, sensitive-domain abuse, cross-boundary data leakage, and resource misuse. Measure risk reduction against a fixed adversarial corpus.

## Isolation rule

Read the requirements, `Claude.md`, this prompt, relevant source/feature docs, and approved security references/fixtures only. Never read another implementation prompt. Tell all subagents the same.

## Feature builds

### P08-F01 Trust labeling and content firewall

- **Tools:** typed trust metadata, sanitizers, policy engine, unit/property/fuzz tests.
- **Depends on:** extraction, API discovery, orchestrator.
- **Concurrency:** parallel with P08-F02–F05 via subagents with exclusive modules.
- **Build steps:**
  1. Extend all message/evidence/tool contracts with a required trust class (`system`, `user`, `application`, `tool`, `page`, `external_api`) and immutable provenance IDs; reject unlabeled ingress at runtime boundaries.
  2. Centralize model-prompt assembly in `apps/renderer/src/server/security/content-firewall/`, placing trusted policy in system messages and serializing untrusted page/API values into bounded typed data blocks with explicit non-instruction framing.
  3. Add canonicalization and sanitization for Unicode controls, encoded/nested values, hidden DOM, metadata, URLs, and structured API fields; retain a safe visible representation and quarantine suspicious portions with reason codes.
  4. Apply content minimization before model calls: select task-relevant evidence chunks, cap nesting/fields/text, strip active markup and unsupported media instructions, and keep original authenticated content outside model context.
  5. Add a policy invariant after each model/tool turn: untrusted content cannot register tools, change system/policy text, select credentials, expand origins, authorize actions, or satisfy confirmation; fail closed and audit attempted violations.
- **Validate:** hidden DOM/CSS, encoded text, metadata, nested JSON, multilingual injection, instruction-conflict, and content-size fuzz corpus.

### P08-F02 Sensitive-domain and egress policy

- **Tools:** policy-as-code, URL/DNS validation, domain categories, integration tests.
- **Depends on:** navigation and action policy.
- **Concurrency:** parallel with P08-F01/F03/F04/F05.
- **Build steps:**
  1. Define a versioned sensitive-domain/category registry with exact/punycode-normalized domains, category, allowed modes/actions, data restrictions, approval owner, review/expiry, and kill switch; avoid uncontrolled suffix wildcards.
  2. Build one egress decision service used by navigation, discovered APIs, actions, live view, redirects, uploads/downloads, and popup handling; its input must include resolved IPs, origin transition, method, action/data category, and current site policy.
  3. Re-resolve and re-evaluate initial URLs and every redirect/connection target, block private/link-local/metadata/reserved ranges and non-HTTP schemes, and pin/compare connection resolution to mitigate DNS rebinding.
  4. Encode category defaults: deny autonomous handling of credentials/identity/payment secrets, require elevated exact confirmation for permitted sensitive mutations, and default-deny cross-origin data transfer, download execution, or upload.
  5. Return stable decision/rule/version for audit and user-safe explanations; cache only bounded decisions and invalidate immediately on kill switch or policy revision.
- **Validate:** look-alike/IDN, redirect chains, DNS rebinding protections, subdomain boundaries, category decisions, and bypass attempts.

### P08-F03 Rate limiting, quotas, and abuse controls

- **Tools:** Redis atomic limits, queue quotas, metrics/alerts, load tests.
- **Depends on:** Phase 7 sessions/queue.
- **Concurrency:** parallel with other hardening builds.
- **Build steps:**
  1. Define named limits and scopes in validated config: requests/tokens/tool calls, navigation/API/action attempts, concurrent tasks/browsers/live streams, queue depth, extracted bytes, frame bandwidth, and per-site rates.
  2. Implement Redis Lua/atomic token-bucket or sliding-window primitives keyed by tenant/user/session/site/tool with server-controlled identifiers, TTLs, bounded cardinality, and explicit fail-open/closed choice (security/cost limits fail closed).
  3. Enforce admission before expensive work and consumption during streams/extraction; combine global, tenant, user, and site decisions and return retry-after without exposing other users' usage.
  4. Add dependency/site circuit breakers driven by rolling failure/latency thresholds, half-open probes, manual kill switch, and queue backpressure that keeps chat cancellation/status responsive.
  5. Instrument decisions and saturation without raw inputs, expose user-safe degraded states, and test atomicity across workers plus cleanup of abandoned capacity leases.
- **Validate:** burst/sustained load, distributed workers, reset/clock boundaries, queue exhaustion, circuit recovery, and no cross-tenant interference.

### P08-F04 Audit, privacy, and incident controls

- **Tools:** structured redacted telemetry, immutable audit sink abstraction, secret/PII scanners, dashboards.
- **Depends on:** all security boundaries.
- **Concurrency:** parallel with P08-F01–F03/F05.
- **Build steps:**
  1. Define an append-only security event schema for policy, confirmation, action, credential access, navigation/egress, rate-limit, injection detection, kill switch, and administrative change with actor, target IDs, versions, outcome, and correlation only.
  2. Add a structured telemetry facade used by both runtimes that recursively redacts configured keys/patterns, hashes only approved identifiers, caps values, and disallows page bodies, prompts, cookies, tokens, and credential values by type.
  3. Route operational metrics/logs and immutable audit records to separate sink interfaces with tenant access controls and enforced retention; implement privacy deletion linkage without permitting audit tampering.
  4. Implement server-owned global/site/tool/action kill switches checked at operation admission and immediately before mutation; propagate revisions to workers and UI and record who/why/when.
  5. Implement an authorized export that selects by correlation/time/event type, re-redacts output, records export access, and contains no secret/raw content; test with canary PII/secrets and a kill-switch drill.
- **Validate:** credential/PII canaries, audit completeness, deletion, kill switch under load, tamper detection, and incident drill.

### P08-F05 Adversarial regression harness

- **Tools:** pytest/Vitest/Playwright, local malicious-site fixtures, image metadata/OCR fixture where supported, fixed scored corpus.
- **Depends on:** golden suite framework; initial corpus can be built concurrently.
- **Concurrency:** parallel with defenses, then rerun after integration.
- **Build steps:**
  1. Create `tests/adversarial/fixtures/` with a local malicious web/API service and versioned manifest describing attack ID/category, setup, task, expected policy/tool/output outcome, and forbidden observable effects.
  2. Implement fixtures for hidden/CSS/Unicode/encoded instructions, image alt/metadata/OCR-like text, IDN/look-alike/redirect domains, malicious JSON fields, form/tool escalation, data-exfiltration URLs, confirmation replay/tamper, and oversized/slow resources.
  3. Build a runner that creates isolated user/site/browser sessions, seeds unique canary secrets, invokes the real orchestrator path deterministically, captures sanitized decisions/tool calls/network destinations, and cleans all state.
  4. Score safe outcome, false block, forbidden tool/action/network attempt, secret leakage, and timeout/resource exhaustion; compare against committed expected results in automated assertions.
  5. Split the corpus into fast CI and extended scheduled suites without weakening assertions, pin model/test configuration where possible, and quarantine only with owner/reason/expiry rather than silently skipping.
- **Validate:** deterministic scoring, false-positive baseline, reproducibility, and CI-safe local execution.

### P08-F06 Integrated hardening

- **Tools:** full golden/adversarial suites, load tests, security checklist.
- **Depends on:** P08-F01–F05.
- **Concurrency:** integrate after dependencies; execute attack categories and load suite concurrently in isolated environments.
- **Build steps:**
  1. Add integration assertions/middleware so routes, workers, bridge tools, generated UI commands, live inputs, navigations, API invocations, and action executors cannot run without the applicable decisions and correlation context.
  2. Run the adversarial corpus against a recorded baseline and hardened build, triage every success/false positive, close shared bypasses at the central boundary, and add a regression fixture for each fix.
  3. Run isolated load/rate/circuit/kill-switch, secret/PII canary, tenant isolation, cancellation, and full golden-task suites; quantify latency/token/task-success impact introduced by controls.
- **Validate:** measure successful attack rate before/after, false positives, latency cost, rate-limit behavior, secret/PII leakage, and kill switches. Never fabricate third-party red-team results.

## Phase acceptance

All known attack fixtures produce their expected safe outcomes or have an explicitly accepted residual risk. Report measured attack-rate reduction, false positives, performance impact, and remaining high-severity issues in the final response; high-severity bypasses block completion.
