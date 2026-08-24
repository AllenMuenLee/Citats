# Phase 0 — Architecture and Environment

## Mission

Build an installable Electron desktop application, not a website. Next.js/React is the desktop renderer; Electron owns native lifecycle and the secure boundary to the local Python/Nodriver service.

Create the monorepo foundation, the Next.js/TypeScript ↔ Python/Nodriver service boundary, and the canonical Mistral tool-call contract. Do not implement chat UX or real browsing.

## Claude execution restriction

Claude must not create, spawn, delegate to, or use subagents while executing this prompt. Claude must perform all work directly in the primary agent context. This restriction overrides every subagent or agent-based concurrency instruction in this prompt.

## Isolation rule

Read only the project requirements, `docs/desktop-architecture-and-ui-specification.md`, `Claude.md`, this prompt, and relevant source/config files. **Never read another implementation prompt.** Tell every subagent the same. Stop when this phase is complete.

## Feature builds

### P00-F01 Monorepo and local environment

- **Tools:** package manager/workspaces, Electron, Next.js + TypeScript, Python 3.12, FastAPI, uv/pytest, Docker Compose, Electron packaging, lint/format tools.
- **Depends on:** none.
- **Concurrency:** run concurrently with P00-F03 using separate subagents.
- **Build steps:**
  1. Create workspace roots `apps/desktop`, `apps/renderer`, `services/browser`, `packages/contracts`, and `packages/ui`; add root workspace configuration and scripts named `dev`, `package`, `lint`, `typecheck`, and `test` that dispatch to both runtimes.
  2. Scaffold `apps/desktop` as strict TypeScript Electron main/preload code, `apps/renderer` as a strict TypeScript Next.js App Router renderer, and `services/browser` as an installable typed Python package with FastAPI, pytest, Ruff, and mypy/pyright.
  3. Configure Electron with context isolation, renderer Node integration disabled, a minimal typed preload allowlist, denied unexpected navigation/new windows/permissions, and a main-process-owned lifecycle for the loopback-only Python service.
  4. Implement an internal renderer health route and `/health/live` plus `/health/ready` in FastAPI. The Electron main process must verify readiness using a random per-launch service token that never reaches renderer code or logs.
  5. Add root `compose.yaml` Postgres and Redis development services with health checks and named volumes; desktop/backend processes consume configured host/port values rather than hard-coded container names.
  6. Add safe `.env.example` files, ignore local secrets/runtime profiles, configure a packaged desktop artifact target, and run secret scanning before finishing.
- **Validate:** clean installs, frontend and Python type/lint checks, health endpoints, and Compose config validation.

### P00-F03 Canonical tool-call contract

- **Tools:** JSON Schema or Zod as source of truth, generated JSON schema/Pydantic models, contract fixtures, Vitest and pytest.
- **Depends on:** none.
- **Concurrency:** run concurrently with P00-F01.
- **Build steps:**
  1. Make `packages/contracts/src/` the source of truth and define closed, versioned schemas for tool definitions, invocation arguments, success/error results, progress events, cancellation, evidence/citations, sensitivity, and correlation metadata.
  2. Add explicit maximum lengths/counts, enums, URL constraints, and `additionalProperties: false`; model credentials only as opaque handles and reject cookie/auth/header fields by schema and recursive safety validation.
  3. Export TypeScript types and JSON Schema from the source definitions, then generate or load matching Pydantic models in `services/browser/src/browser_service/contracts/` from the committed schema artifact.
  4. Create identical valid and invalid fixtures under `packages/contracts/fixtures/`; execute them from Vitest and pytest so neither runtime can drift independently.
  5. Add a deterministic generation/check script that fails CI when generated schema/models are stale.
- **Validate:** valid/invalid fixtures pass in both languages; schema generation is reproducible; round-trip serialization and backward-incompatible-version rejection are tested.

### P00-F04 Bridge integration harness

- **Tools:** FastAPI TestClient/httpx, Next.js server test tooling, OpenAPI/client generation if adopted.
- **Depends on:** P00-F01, P00-F03.
- **Concurrency:** begin after its dependencies.
- **Build steps:**
  1. Implement a typed FastAPI bridge route under `services/browser/src/browser_service/api/` that accepts the invocation envelope and dispatches only the registered `system.echo` stub.
  2. Implement `system.echo` in a tool registry module; return the input payload plus correlation metadata, support a bounded artificial delay for tests, and observe an asyncio cancellation signal.
  3. Add a trusted local bridge client in `apps/renderer/src/server/browser-service/` with base URL validation, per-call timeout, abort propagation, response-schema validation, per-launch authentication, and normalized unavailable/timeout/contract error classes.
  4. Add an internal Next.js test route or server harness that calls the client without exposing arbitrary tool invocation to browsers; carry one request ID through web logs, HTTP headers, FastAPI context, and response.
  5. Add structured logging in both services with the same correlation keys and a recursive redaction filter, then create end-to-end tests for success, invalid input, unknown tool, timeout, cancellation, and unavailable service.
- **Validate:** end-to-end contract test, malformed payload tests, unavailable-service test, latency baseline, and no-secret log snapshot.

## Phase acceptance

Run all root checks and the bridge contract suite. Do not add Mistral calls or launch Nodriver against external sites.
