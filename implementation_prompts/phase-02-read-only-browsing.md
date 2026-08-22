# Phase 2 — Read-Only Browsing

## Mission

Allow the agent to navigate public pages, extract bounded content, and answer with verifiable citations. It must not click state-changing controls, submit forms, use authenticated sessions, or discover/replay private APIs.

## Isolation rule

Read only the requirements, `Claude.md`, this prompt, relevant code, and relevant completed feature docs. Never read another implementation prompt; impose this on subagents.

## Feature builds

### P02-F01 Nodriver lifecycle and safe navigation

- **Tools:** Nodriver, FastAPI, asyncio, pytest, local fixture web server.
- **Depends on:** Phase 0 bridge.
- **Concurrency:** parallel with P02-F02 and P02-F03 using subagents.
- **Build steps:**
  1. Create `services/browser/src/browser_service/browser/` with a lifecycle manager that starts one controlled Chrome process and allocates an isolated ephemeral context/profile per task; expose context creation through an async context manager.
  2. Implement a URL policy that accepts only configured `http`/`https`, rejects credentials/fragments where inappropriate, resolves hostnames, blocks loopback/private/link-local/metadata ranges, and rechecks every redirect target.
  3. Add a navigation service with total and idle timeouts, cancellation, maximum redirects, response-size/resource-type controls, and an explicit read-only operation enum; do not expose click, form, script-evaluation, or mutation endpoints.
  4. Track contexts/pages/process resources in a registry; close them in `finally`, reap abandoned tasks, cap concurrent contexts/pages/memory, and restart an unhealthy browser process without mixing sessions.
  5. Add a test-only network-policy override limited to the local fixture server and make it impossible to activate in production configuration.
- **Validate:** allowed public/local test navigation, blocked file/private/loopback targets except explicit test fixture configuration, redirect revalidation, timeout/cancel, and leak/stability tests.

### P02-F02 Content extraction pipeline

- **Tools:** DOM APIs through Nodriver, readability-style parsing, sanitization, Pydantic, pytest fixtures.
- **Depends on:** browser service shell.
- **Concurrency:** parallel with P02-F01 and P02-F03; use saved/local HTML fixtures until integration.
- **Build steps:**
  1. Define Pydantic extraction models under `services/browser/src/browser_service/extraction/` for document metadata, ordered content blocks, source anchors, warnings, and truncation details.
  2. Obtain the post-render DOM through the browser adapter, remove scripts/styles/forms/noscript/templates and elements hidden by attributes or computed style, then select main content using semantic containers with a deterministic body fallback.
  3. Normalize whitespace and Unicode while preserving headings, lists, tables, and link relationships; capture title, final/canonical URL, language, description, publication time when trustworthy, and anchor text/target.
  4. Scan extracted values for credential-shaped/high-risk fields and untrusted-instruction indicators, label all page content as untrusted, and omit binary/data URLs plus form values.
  5. Split content at structural boundaries into stable, bounded chunks with document-local IDs and character offsets; enforce document/chunk/count limits and emit explicit truncation warnings.
- **Validate:** fixed diverse page set, extraction accuracy assertions, encoding/large-page handling, malicious hidden-text fixtures, and payload/token bounds.

### P02-F03 Citation contract and rendering

- **Tools:** shared schemas, React citation component, Vitest/Testing Library.
- **Depends on:** P00-F03.
- **Concurrency:** parallel with P02-F01/F02.
- **Build steps:**
  1. Extend the shared contract with `Source`, `EvidenceChunk`, and `Citation` types containing stable IDs, normalized URL, title, retrieved timestamp, chunk reference, and exact character span or supported quote hash.
  2. Implement server-side citation resolution that accepts only source/chunk IDs returned by the current tool invocation and verifies every claimed span against normalized evidence before streaming it.
  3. Define a stream part for citation markers and a final source list; preserve mapping across partial text deltas and reject duplicate/conflicting IDs or citations to truncated/missing evidence.
  4. Build React inline marker, source popover/list, and approved external-link components under `apps/renderer/src/components/citations/`; sanitize protocols, show destination origin, and route opening through the Electron main-process allowlist.
  5. When citation validation fails, omit the invalid marker, flag the answer as unsupported, and surface a non-fatal diagnostic rather than linking unrelated evidence.
- **Validate:** schema tests, missing/duplicate source handling, rendering/a11y, URL sanitization, and evidence-link checks.

### P02-F04 Browse/read orchestrator integration

- **Tools:** canonical tool registry, Mistral tool loop, bridge client, end-to-end tests.
- **Depends on:** P02-F01, P02-F02, P02-F03.
- **Concurrency:** integrate after dependencies.
- **Build steps:**
  1. Add a FastAPI `navigate_and_extract` handler that composes URL policy, browser context, navigation, and extraction and returns the canonical result envelope with timing/warnings; keep lower-level browser primitives private.
  2. Register the matching tool in the orchestrator with URL-only input, read-only sensitivity, result-size limits, and the shared evidence schema; serialize only bounded extracted chunks to Mistral.
  3. Update system/tool instructions to require claims about a fetched page to reference returned source/chunk IDs and to state when evidence is missing, blocked, timed out, or truncated.
  4. Validate model-emitted citations before sending final stream parts; retain valid cited text, mark unsupported output, and never manufacture a title, URL, or page claim on tool failure.
  5. Add end-to-end fixture scenarios for static, client-rendered, redirected, malformed, oversized, blocked, and malicious pages and collect navigation/extraction/citation/resource metrics per case.
- **Validate:** golden page-question set for answer/extraction accuracy, navigation success rate, citation correctness, repeated-session resource use, and proof that mutation methods/tools are unavailable.

## Phase acceptance

Run the fixed read-only golden set and record accuracy, citation validity, success rate, latency, memory, and browser cleanup. All tests use local fixtures or explicitly approved public test pages.
