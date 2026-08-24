# Phase 9 — Closed Alpha

## Mission

Prepare and operate a narrow, research/comparison-first closed alpha with consented users, observable reliability, feedback loops, and fast rollback. Transactions remain disabled unless separately and explicitly approved.

## Claude execution restriction

Claude must not create, spawn, delegate to, or use subagents while executing this prompt. Claude must perform all work directly in the primary agent context. This restriction overrides every subagent or agent-based concurrency instruction in this prompt.

## Isolation rule

Read only the requirements, `Claude.md`, this prompt, relevant code/feature docs, and approved alpha policy/materials. Never read other implementation prompts. Enforce this in subagent tasks.

## Feature builds

### P09-F01 Alpha scope, eligibility, and feature flags

- **Tools:** server-side feature flags, allowlists, policy config, tests.
- **Depends on:** Phase 8 acceptance.
- **Concurrency:** parallel with P09-F02–F05 via subagents.
- **Build steps:**
  1. Create a versioned alpha configuration defining invited cohort IDs, supported task categories/sites/tools/modes, per-cohort capacity, excluded sensitive/transaction actions, rollout percentage, start/end, owner, and approval status.
  2. Implement server-side flag evaluation requiring authenticated user plus active cohort membership; derive flags at every route/worker admission and never trust client-supplied cohort, site, or capability flags.
  3. Add independent global/cohort/site/tool flags and an overriding transaction-disable rule enforced in policy and both executors, not only hidden in UI.
  4. Build administrative configuration validation and cache invalidation with fail-closed behavior, separation of edit/approve where available, and audited emergency rollback/kill-switch operations.
  5. Add staged rollout support and a read-only diagnostic showing effective flags/reason to authorized operators; test non-invited users, stale cache, partial rollout determinism, and rollback while tasks run.
- **Validate:** authorization, flag propagation/cache, cohort isolation, transaction denial, rollback, and fail-closed configuration.

### P09-F02 Privacy-safe product analytics

- **Tools:** typed event schema, privacy review checks, analytics sink abstraction, SQL/dashboard tests.
- **Depends on:** audit/privacy controls.
- **Concurrency:** parallel with P09-F01/F03/F04/F05.
- **Build steps:**
  1. Add a versioned analytics event package and server collector that attaches pseudonymous cohort/user/task IDs, consent version, correlation, feature versions, and timestamps while rejecting unrecognized/oversized fields.
  2. Emit lifecycle events at task accepted/started/completed/failed/cancelled, citation opened, UI mode used, confirmation decision, attempted blocked transaction, and optional satisfaction response; deduplicate by event ID.
  3. Store analytics in a tenant-restricted sink separate from operational logs, apply retention/deletion/opt-out before collection and downstream export, and prevent joining back to credentials/raw conversations.
  4. Implement tested queries/views for task mix, completion, p50/p95 latency, failure reasons, citation use, confirmation, trust/satisfaction, and retention with minimum cohort-size suppression.
- **Validate:** event schema, deduplication, consent/opt-out, tenant isolation, PII canaries, metric definitions, and deletion propagation.

### P09-F03 Feedback and issue triage

- **Tools:** in-product feedback UI, redacted diagnostic bundle, issue severity rubric, tests.
- **Depends on:** security observability.
- **Concurrency:** parallel with P09-F01/F02/F04/F05.
- **Build steps:**
  1. Define feedback schema with task ID, coarse rating/reason codes, optional bounded note, consent for diagnostic attachment, client/app versions, and server-derived user/cohort/correlation ownership.
  2. Build an accessible feedback control on terminal task results with clear optionality, privacy warning for notes, editable consent, success/retry state, and no credential/page snapshot attachment by default.
  3. Validate ownership server-side, sanitize/redact note text, create an idempotent feedback record, and if consented attach only a predeclared diagnostic manifest of redacted event IDs/versions/timings.
  4. Implement triage classification with severity, component/feature ID, owner, SLA, status, duplicate linkage, and a separate security escalation that can activate the relevant kill switch.
- **Validate:** accessibility, submission retry/dedup, redaction, opt-out, cross-user access, and urgent kill-switch workflow.

### P09-F04 Alpha onboarding and trust UX

- **Tools:** React onboarding, consent records, user-facing help content, Playwright/a11y tests.
- **Depends on:** alpha scope.
- **Concurrency:** parallel with P09-F01–F03/F05.
- **Build steps:**
  1. Write versioned alpha disclosure content covering research-first scope, unsupported/experimental behavior, citations and verification, generated versus live site views, site/session data, credential isolation, and disabled/gated actions.
  2. Build a resumable onboarding flow requiring explicit consent to the current policy version before alpha routes activate; record server-side version/time/user and force re-consent only for material version changes.
  3. Add concise contextual trust cues in chat, citations, generative UI, live view, and confirmations linking to the relevant explanation rather than repeating the full onboarding.
  4. Implement user-accessible controls to review/delete conversation history, disconnect/revoke site sessions/credentials, opt out of analytics where applicable, leave alpha, and contact support with correlation ID.
  5. Add accessibility/comprehension tests and automated flows for accept/decline/interrupted onboarding, version change, account removal, session revoke, and support link.
- **Validate:** consent required/versioned, keyboard/screen reader, comprehension protocol, account removal, and links to controls.

### P09-F05 Reliability and operations readiness

- **Tools:** SLOs, dashboards/alerts, synthetic golden tasks, backup/restore and incident drills.
- **Depends on:** telemetry and golden suite.
- **Concurrency:** parallel with other alpha preparation.
- **Build steps:**
  1. Define alpha SLIs/SLOs and windows for availability, research task completion, navigation success, valid citations, time to first response/task completion, queue wait, browser crash/leak, and security-control availability.
  2. Instrument service/worker/browser/queue/tool paths with low-cardinality metrics and trace correlation, then create dashboards segmented by release/cohort/site/mode without exposing user content.
  3. Configure actionable burn-rate/capacity/security alerts with owner, severity, threshold, deduplication, and tested notification route; alert on missing telemetry as well as failures.
  4. Schedule synthetic local/approved golden tasks and drift probes, perform load/failure/backup restore/kill-switch drills, and enforce conservative invitation limits from measured capacity.
- **Validate:** alert tests, failure injection, rollback, restore, capacity/load, stale dependency/site drift, and incident drill.

### P09-F06 Alpha evaluation and iteration gate

- **Tools:** analytics queries and privacy-preserving cohort analysis.
- **Depends on:** P09-F01–F05 and actual consented usage.
- **Concurrency:** after launch; metric analysis and qualitative synthesis may run concurrently.
- **Build steps:**
  1. After the evaluation window, reconcile approved aggregate metrics across analytics, task outcomes, incidents, and feedback while preserving minimum sample/privacy thresholds.
  2. Analyze research/comparison share versus admin/stateful/attempted transaction, completion/latency/failure by category/site, citation behavior, satisfaction/trust, safety events, and qualitative themes from consented feedback.
  3. Convert findings into ranked, bounded experiments/fixes with feature owner, hypothesis, metric, guardrail, rollout, and stop condition; add regressions for confirmed defects before rollout.
- **Validate:** metric reconciliation, sample-size caveats, bias/privacy review, threshold decisions, and regression results for fixes.

## Phase acceptance

Before inviting users, alpha controls, consent, privacy, SLOs, kill switches, transaction denial, and incident response must pass. Completion requires either real consented results or an explicitly labeled launch-ready state awaiting users—not fabricated findings.
