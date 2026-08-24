# Phase 10 — Broaden Coverage Carefully

## Mission

Expand sites and use cases through evidence-based adapters and conformance tests. Expand transaction capability only after explicit trust/reliability thresholds and human approval are met.

## Claude execution restriction

Claude must not create, spawn, delegate to, or use subagents while executing this prompt. Claude must perform all work directly in the primary agent context. This restriction overrides every subagent or agent-based concurrency instruction in this prompt.

## Isolation rule

Read the requirements, `Claude.md`, this prompt, relevant code/feature docs, alpha evidence, and candidate-site review only. Never read any other implementation prompt. Require subagents to obey this.

## Feature builds

### P10-F01 Coverage intake and risk scoring

- **Tools:** typed candidate registry, policy/ToS/security/privacy checklist, analytics evidence, scoring tests.
- **Depends on:** Phase 9 evidence/readiness.
- **Concurrency:** parallel with P10-F02, P10-F03, P10-F04 via subagents.
- **Build steps:**
  1. Define a candidate-registry schema with site/use case, demand evidence, supported task/mode, technical/API/DOM assessment, authentication/data categories, legal/ToS/privacy/security review, owner, cost, status, review dates, and kill switch.
  2. Implement a weighted scoring rubric with hard gates for human review, security/data sensitivity, testability, ownership, and rollback; demand/reliability can rank candidates but cannot override a hard denial.
  3. Implement a deterministic scoring/lint tool that validates evidence links/dates, normalizes domains, flags conflicts/expired reviews, records rubric version, and outputs ranked approved candidates separately from pending/denied.
  4. Require distinct reviewer fields/approval for real-site discovery, authenticated access, live view, and each mutation; initial status is pending and no code/config generator may turn score into approval.
- **Validate:** required evidence fields, expired review, score reproducibility, reviewer signoff presence, and no auto-approval.

### P10-F02 Site adapter/plugin contract

- **Tools:** versioned interfaces/schemas, conformance harness, local site simulators, contract tests.
- **Depends on:** browser/API/UI contracts.
- **Concurrency:** parallel with P10-F01/F03/F04.
- **Build steps:**
  1. Define a versioned `SiteAdapter` interface in a dedicated package/module with site ID/version, domain matcher, capability declaration, extraction normalization, discovered-operation bindings, UI-result transformer, drift probes, and optional action/live-view policy references.
  2. Keep core navigation/security/session/action behavior outside adapters; adapter methods may return declarative selectors/schemas/mappings only and cannot access credentials, raw sockets, arbitrary CDP, policy overrides, or unrestricted HTTP.
  3. Establish `adapters/<site-id>/` layout for manifest, implementation, schemas, local/sanitized fixtures, conformance tests, and golden tasks; require static registration in a closed registry.
  4. Implement adapter loading that checks manifest/interface/core compatibility, approved site-policy version, enabled flag, domain scope, and integrity before registration; one adapter failure must quarantine only that adapter.
  5. Build a reference local-fixture adapter and conformance kit testing domain matching, bounded output/provenance, redaction, deterministic normalization, policy non-bypass, fallback, drift, disable, and cleanup.
- **Validate:** reference adapter, conformance failures, version mismatch, policy bypass resistance, redaction, drift, and disable behavior.

### P10-F03 Automated coverage and drift qualification

- **Tools:** golden tasks, scheduled CI/worker jobs, synthetic accounts/local replicas, metrics and alerts.
- **Depends on:** golden suite and adapter contract draft.
- **Concurrency:** parallel with P10-F01/F02/F04.
- **Build steps:**
  1. Define a qualification manifest per adapter listing approved test environment/account, extraction questions/evidence, API schemas, UI fixtures, safe read/action checks, drift probes, performance budgets, and minimum pass thresholds.
  2. Add scheduled workers/CI jobs that run deterministic local fixtures on every change and approved live canaries at limited frequency, isolated credentials/profile/quotas, with no state mutation unless explicitly qualified.
  3. Compare selectors, endpoint/response schemas, normalized results, citations, screenshots where safe, success and latency against versioned baselines; classify compatible drift, degraded behavior, and unsafe breakage.
  4. Feed qualification state into adapter admission: unsafe/security/policy failures immediately quarantine, reliability regressions stop rollout, and restoration requires passing runs plus reviewed acknowledgement.
- **Validate:** intentional drift fixtures, flake policy, quarantine/restore, site isolation, and canary rollback.

### P10-F04 Transaction expansion gate

- **Tools:** policy-as-code, signed approvals, and reliability/security metrics.
- **Depends on:** action coordinator and alpha metrics.
- **Concurrency:** parallel policy work, but no enablement before P10-F01/F03 evidence.
- **Build steps:**
  1. Define a versioned transaction-gate policy with exact site+action key and minimum evidence for sample size/window, success, failure/unknown outcomes, idempotency/postcondition, confirmation precision, adversarial pass rate, trust, incidents, support, and human approvals.
  2. Implement an evaluator that reads immutable metric/report references, checks freshness and denominators, applies all hard thresholds, and returns denied/pending/approved with failed criteria; missing or stale evidence always blocks.
  3. Require signed separation-of-duties approval from product/security/site-policy owners and bind approval to adapter, endpoint/action schema, policy, confirmation UI, and executor versions so changes revoke eligibility.
  4. Create per-action staged flags for internal test, tiny canary, limited cohort, and wider alpha with volume/value/rate limits, mandatory confirmation, kill switch, monitoring, and automatic rollback thresholds.
  5. Enforce the gate immediately before action planning and execution in addition to UI visibility; keep research/read-only paths independently available and test stale evidence, version drift, forged approval, canary breach, and rollback.
- **Validate:** insufficient/missing/stale evidence denies, approval separation, canary limits, confirmation invariants, rollback, and transaction-attempt analytics.

### P10-F05 First coverage batch

- **Tools:** adapter contract, local fixtures/simulators, approved pilot access, full conformance/golden suites.
- **Depends on:** P10-F01–F04.
- **Concurrency:** assign one subagent per approved site/use case with exclusive adapter/fixture ownership; integrate shared contract changes centrally. Do not start candidates lacking approval.
- **Build steps:**
  1. Select only the top small batch whose intake status is approved; assign one subagent exclusive ownership of each `adapters/<site-id>/` directory/fixtures/docs and one integrator ownership of shared registry/contracts.
  2. For each adapter, create manifest/capabilities/domain policy, local sanitized simulator fixtures, extraction/normalization, approved API bindings, registered generative UI mapping or embedded fallback, drift probes, and flags.
  3. When an adapter exposes a missing shared need, propose a generic declarative contract extension with cross-adapter fixtures, security review, versioning, and backward compatibility; do not insert site conditionals into core orchestration.
  4. Run local conformance/golden/security/redaction/performance/fallback tests, then approved live read-only qualification; enable only an internal canary and monitor the per-site SLO/drift/quarantine signals before cohort expansion.
  5. Keep mutation capabilities absent/disabled unless the exact site+action passes P10-F04; test site kill switch, adapter quarantine, rollback to prior version, profile/session isolation, and removal without affecting other adapters.
- **Validate:** per-site conformance, golden tasks, security/redaction, drift, performance, fallback, canary and rollback. Mutations stay disabled unless P10-F04 passes for that exact action/site.

## Phase acceptance

Every new site/use case is reviewed, owned, isolated, feature-flagged, tested, monitored, and reversible. Transaction enablement is per-site/per-action and blocked unless all evidence and approval gates pass. Re-run the entire cross-category golden suite.
