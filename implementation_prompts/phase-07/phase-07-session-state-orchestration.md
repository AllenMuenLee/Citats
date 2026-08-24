# Phase 7 — Session, State, Credentials, and Multi-Task Orchestration

## Mission

Persist conversations and browser state safely, isolate users/sites, keep credentials outside model/log contexts, and run multiple cancellable browser tasks concurrently.

## Isolation rule

Read only the requirements, `Claude.md`, this prompt, relevant source, and relevant feature docs. Never read other implementation prompts, and state that rule in subagent assignments.

## Feature builds

### P07-F01 Conversation/history persistence

- **Tools:** Postgres, migrations, repository layer, encryption where required, integration tests.
- **Depends on:** conversation state.
- **Concurrency:** parallel with P07-F02, P07-F03, P07-F04 via subagents; separate migrations/tables.
- **Build steps:**
  1. Design migrations for tenant/user references, conversations, ordered turns/parts, task summaries/outcomes, and citation/source metadata with UUIDs, timestamps, version columns, ownership foreign keys, and deletion/retention markers.
  2. Implement a repository under `apps/renderer/src/server/persistence/` that requires tenant/user context on every method, uses transactions for turn ordering, supports cursor pagination, and never offers unscoped list/get operations.
  3. Serialize only validated bounded conversation parts; remove credentials/raw authenticated page data, preserve trust/provenance labels, and encrypt specifically classified stored content through an abstraction rather than inline keys.
  4. Replace the Phase 1 in-memory repository behind the existing interface, restore recent context using the same bounded policy, and make writes idempotent by turn/request ID for stream retries.
  5. Add retention and user-deletion jobs that cascade or tombstone dependent outcomes/sources/audits according to policy and verify restart recovery from a disposable Postgres instance.
- **Validate:** migrations up/down in disposable DB, ordering/pagination, restart persistence, tenant isolation, redaction, and retention tests.

### P07-F02 Browser session/profile persistence

- **Tools:** Nodriver profile management, encrypted metadata store, Redis leases, pytest.
- **Depends on:** browser lifecycle.
- **Concurrency:** parallel with P07-F01/F03/F04.
- **Build steps:**
  1. Define metadata tables/repository for opaque profile ID, tenant/user, canonical site scope, encrypted storage reference, status, last used, expiry, version, and active lease—never raw cookies.
  2. Implement a profile store inside the browser service that creates a distinct filesystem/object-store archive per user+site, encrypts it with a vault-managed data key, validates archive paths, and restores only into a task-scoped directory.
  3. Add Redis lease acquisition/heartbeat/release with unique lease tokens and compare-and-delete semantics so two workers cannot mount the same mutable profile concurrently.
  4. Integrate lifecycle allocation to restore before browser start, persist sanitized/encrypted state after clean close, and quarantine rather than overwrite corrupt or version-incompatible profiles.
  5. Implement expiry, logout/revoke, orphaned-lease recovery, and workspace cleanup; verify cookies from one site/user never appear in another context or archive.
- **Validate:** restart continuity, concurrent lease conflict, expiry/revoke, cross-user/site isolation, corrupt profile recovery, and cleanup.

### P07-F03 Credential vault adapter

- **Tools:** vault interface with development backend and production-provider seam, envelope encryption, secret scanners, audit events.
- **Depends on:** architecture credential boundary.
- **Concurrency:** parallel with P07-F01/F02/F04.
- **Build steps:**
  1. Define a `CredentialVault` interface in the browser service with create/get/rotate/delete by tenant/user/site and opaque handle, plus a development backend using encrypted-at-rest storage and a production-provider adapter seam.
  2. Keep master/provider credentials in runtime secret configuration, use envelope encryption and authenticated metadata, authorize every operation against browser-service identity and user/site scope, and emit payload-free audit events.
  3. Add a credential broker that resolves handles only inside the browser worker and injects values directly into page fields or session setup; return only success/failure and never the value to orchestrator/tool contracts.
  4. Register recursive redaction at configuration, HTTP, browser, logging, tracing, screenshot/DOM-evidence, exception, queue, and persistence boundaries; add schema assertions forbidding credential-like keys in model-facing types.
  5. Run unique canary credentials through success and failure flows, scan all observable artifacts, then test rotation, revocation, unauthorized/cross-site handles, vault outage, and deletion.
- **Validate:** canary secret never appears in model requests, logs, DB rows, traces, screenshots, or errors; authorization, rotation/revocation, and unavailable-vault behavior.

### P07-F04 Durable task queue and worker model

- **Tools:** BullMQ or Celery (choose one consistent owner), Redis, worker heartbeats, integration tests.
- **Depends on:** Phase 0 queue seam.
- **Concurrency:** parallel with persistence builds.
- **Build steps:**
  1. Choose one queue owner/runtime based on existing orchestration boundaries and record the decision; define versioned job payloads containing opaque IDs/typed input references only, not credentials or large page data.
  2. Implement enqueue and worker adapters with states queued/running/succeeded/failed/unknown/cancelled, server-generated idempotency key, priority bands, attempts, deadlines, and correlation/user/site metadata.
  3. Add Redis-backed atomic per-user/site/global admission quotas, worker lease/heartbeat, progress events, cooperative cancellation flags, and cancellation propagation into browser/model/network calls.
  4. Define retry policy by operation safety: retry read-only transient failures with jitter, retry mutations only with proven idempotency, and quarantine malformed/version-unknown jobs; recover expired worker leases without duplicate unsafe execution.
  5. Persist terminal summaries and publish ordered progress through the existing stream boundary; clean job artifacts by retention policy and instrument wait/run/retry/cancel/orphan metrics.
- **Validate:** parallel execution, cancellation, retry/duplicate delivery, worker crash/restart, fairness, quotas, and non-blocking chat.

### P07-F05 Unified continuity and multi-task UX

- **Tools:** orchestrator, streaming task events, React task tray, Playwright, failure-injection tests.
- **Depends on:** P07-F01–F04.
- **Concurrency:** integration after dependencies; run continuity, isolation, and concurrency suites in parallel.
- **Build steps:**
  1. Add server APIs to list/resume owned conversations and active/recent tasks with cursor pagination; combine durable task state with live queue events and reconcile missed events after reconnect.
  2. Extend the chat orchestrator to enqueue long browser work, return immediately with task IDs, append terminal outcomes idempotently, and maintain correlation across conversation, queue, worker, browser session, tool, and audit events.
  3. Build a task tray with multiple independent task cards showing site, safe summary, state, progress, elapsed time, result/error, and permitted cancel/retry/open-browser actions without blocking the composer.
  4. Route cancel/retry through owned server records; retry creates a new attempt linked to the original and is disabled for unsafe/unknown mutations, while browser reattach must acquire the correct profile/session lease.
  5. On app/server/worker restart, restore conversation, reconcile queue/leases, reattach or safely mark browser sessions, and render final outcomes exactly once; test three simultaneous sites and deliberate failures for leakage/fairness/responsiveness.
- **Validate:** full restart persistence, three-site parallel scenario, chat responsiveness, cross-tenant/site isolation, vault-context audit, failure recovery, and outcome history.

## Phase acceptance

Pass persistence, restart, multi-task, cancellation, tenant/site isolation, and credential canary audits. Raw credentials must be absent from all LLM inputs and observable logs/artifacts.
