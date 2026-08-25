# Phase 6 — In-App Embedded Browser Mode

## Mission

Provide a secure, usable live browser pane for explicitly whitelisted stateful/visual sites and for workflow steps that require private information, authentication, CAPTCHA/manual resolution, or authentic checkout UI. Authentic-site interaction remains inside the browser boundary; preserve an opaque continuation back to the adaptive workflow and do not recreate these sites.

## Claude execution restriction

Claude must not create, spawn, delegate to, or use subagents while executing this prompt. Claude must perform all work directly in the primary agent context. This restriction overrides every subagent or agent-based concurrency instruction in this prompt.

## Isolation rule

Read the requirements, `Claude.md`, this prompt, relevant code/docs, and site policy records only. Never read another implementation prompt; enforce this for subagents.

## Feature builds

### P06-F01 Fallback classifier and site allowlist

- **Tools:** deterministic rules/config first, optional model signal as non-authoritative input, evaluation fixtures.
- **Depends on:** pilot governance and action policy.
- **Concurrency:** parallel with P06-F02, P06-F03, P06-F04 via subagents.
- **Build steps:**
  1. Define classifier input from trusted normalized URL/site policy plus bounded task capability flags (visual editing, collaboration, continuous state, unsupported API/UI), never raw page instructions.
  2. Implement deterministic rules under `services/browser/src/browser_service/mode/` returning `read_only`, `generated_ui`, `embedded`, or `deny` with rule ID, confidence, reason, and policy version; low confidence defaults to embedded only for an approved origin, otherwise read-only/deny.
  3. Extend site policy with exact embedded-view origins/subdomains, allowed navigation boundaries, authentication/manual-interaction requirements, expiry, and kill switch; normalize IDN and reject look-alike suffix matching.
  4. Allow an optional model recommendation only as an untrusted hint evaluated by deterministic policy; it cannot add an origin or override deny.
  5. Build a labeled local corpus for document editors, social feeds, static articles, product lists, spoofed domains, and mixed tasks; keep Google Docs/Instagram entries pending until human approval exists.
- **Validate:** labeled corpus, accuracy/confusion matrix, spoof/look-alike domains, subdomain rules, low-confidence fallback, and expired allowlist behavior.

### P06-F02 Live-view transport

- **Tools:** CDP screencast or approved streaming mechanism, WebSocket, binary frames, backpressure metrics.
- **Depends on:** browser lifecycle/bridge.
- **Concurrency:** parallel with P06-F01/F03/F04.
- **Build steps:**
  1. Add a browser-service live-view session manager that attaches CDP screencast to one existing browser context/page and issues an opaque short-lived viewer session bound to user/task/browser session.
  2. Define authenticated WebSocket messages for ready, frame metadata/binary payload, frame acknowledgement, viewport change, quality request, heartbeat, warning, and close; version and validate every control message.
  3. Implement a one-or-few-frame bounded buffer with acknowledgement-driven backpressure, adaptive frame rate/quality, monotonic sequence IDs, dropped-frame metrics, and no unbounded queues.
  4. Handle viewport/device-pixel-ratio updates through the page emulation boundary, pause capture when no viewer is attached, and permit reconnect only with a fresh authorized viewer token tied to the same session.
  5. Stop capture, clear buffers, revoke tokens, and detach CDP handlers on cancel/disconnect/expiry/browser crash; exclude frame bytes from logs, traces, persistence, and default error reports.
- **Validate:** latency/fps, bandwidth, resize, reconnect, stalled consumer, multiple isolated sessions, and resource cleanup.

### P06-F03 Input and navigation security boundary

- **Tools:** authenticated WebSocket commands, CSRF/origin checks, CDP input events, security tests.
- **Depends on:** session contract.
- **Concurrency:** parallel with P06-F01/F02/F04.
- **Build steps:**
  1. Define a closed input protocol for pointer, wheel, key, focus, and approved navigation commands with sequence number and viewport coordinates; exclude arbitrary CDP commands and script execution.
  2. Authenticate the WebSocket handshake and every session lookup, verify same-origin/CSRF expectations, user/task/view ownership, active browser lease, expiry, and monotonically increasing sequence numbers.
  3. Translate accepted inputs to CDP events only while the pane has explicit focus; clamp coordinates/key values/rates and drop stale, replayed, over-rate, cross-session, or background inputs.
  4. Intercept navigation/popups/download/upload/clipboard requests at the browser boundary, display an origin change before accepting further input, and apply default-deny site policy with explicit user gesture where permitted.
  5. Keep manual user interaction distinct from assistant action execution; any assistant-originated sensitive click/form/API path must leave live input and enter the Phase 5 plan/policy/confirmation coordinator.
- **Validate:** cross-session injection, forged origin, stale connection, popup/download/upload denial/defaults, clipboard policy, and sensitive action gating.

### P06-F04 Browser pane UI

- **Tools:** React, canvas/video renderer as selected, ResizeObserver, Testing Library/Playwright, accessibility tooling.
- **Depends on:** transport interface draft.
- **Concurrency:** parallel with service builds.
- **Build steps:**
  1. Create `apps/renderer/src/components/browser-pane/` with a session controller hook, render surface, toolbar, connection/status overlay, and error boundary; keep frame decoding/drawing outside React render state.
  2. Render frames at correct aspect ratio/DPR and map pointer coordinates back to the remote viewport; batch high-frequency pointer/wheel events and send keyboard events only when the surface owns focus.
  3. Show trusted server-provided origin/URL, TLS/security status where available, “Live website” labeling, assistant/manual control mode, loading latency, and prominent disconnect/reconnect/close actions.
  4. On focus entry/exit, announce control status, trap no global keyboard shortcuts unnecessarily, provide escape-to-release, and prevent invisible pane input; include accessible alternatives/status for users unable to use the visual stream.
  5. Handle token expiry, network interruption, browser crash, resize, navigation policy block, and reconnect without silently creating a different authenticated session.
- **Validate:** keyboard/focus behavior, responsive fidelity, error states, DPR/resize, visual snapshots, and screen-reader status semantics.

### P06-F05 End-to-end fallback integration

- **Tools:** local stateful visual test app, Playwright, performance instrumentation; approved real-site manual QA only if authorized.
- **Depends on:** P06-F01–F04.
- **Concurrency:** integrate after dependencies; classifier and streaming evaluation can execute concurrently.
- **Build steps:**
  1. Extend the task/orchestrator state with current presentation mode, browser-session reference, workflow ID, handoff reason, expected manual outcome, and opaque continuation handle; call the deterministic classifier before emitting a server-authorized mode-transition event.
  2. On entering embedded mode, acquire/attach the correct isolated browser session, create live-view/input authorizations, and stream only opaque session metadata plus trusted current origin—not pixels, cookies, DOM, or credentials—to the chat layer.
  3. Mount the pane beside chat, preserve conversation/task/workflow correlation, explain why handoff is required and what remains, and pause incompatible generated UI or automated actions while the user holds manual control.
  4. Let the user explicitly return control to the assistant. On return, revoke manual input authority, perform only policy-approved bounded observation sufficient to classify the resulting page/workflow state, and resume through the Phase 5 coordinator; never infer that checkout or another action succeeded solely because navigation occurred.
  5. On exit/disconnect/task completion, revoke input/view tokens, detach or retain the browser session according to policy, restore chat controls, and append a minimal sanitized outcome/origin/workflow-state record for continuity.
  6. Exercise mode changes, private-data handoff, authentication, CAPTCHA/manual resolution, checkout continuation, return-to-assistant, and authentic interactions against a local stateful visual app, then separately run classifier, streaming, security, accessibility, and performance suites; real-site manual QA requires the approved site record/test account.
- **Validate:** classifier accuracy, stream latency/fidelity, authentic interaction test, session isolation, mode transitions, and usability protocol against direct site use.

## Phase acceptance

Use the local test app by default. Do not automate Google Docs or Instagram unless a human has approved the relevant policy/ToS review and test accounts.
