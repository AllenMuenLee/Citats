# Desktop Architecture and UI Specification

## Product form

This product is a **desktop application, not a website**. Users install and launch it as one native desktop workspace containing chat, generated UI, tasks, and an embedded live browser.

Web technology is used only to render the desktop interface. Do not design for public web hosting, browser-tab sessions, public backend routes, or ordinary website navigation. Local orchestration and browser-service endpoints must bind to loopback, authenticate every connection, and never be exposed to the LAN or internet.

Use **Electron** as the initial desktop shell because the requirements already select Next.js, React, TypeScript, and the Vercel AI SDK. Replacing Electron with another shell requires an ADR and equivalent packaging, IPC, browser embedding, and security validation.

## Languages and ownership

| Area | Language | Technology | Ownership |
|---|---|---|---|
| Desktop main and preload | TypeScript | Electron | Windows, native lifecycle, secure IPC, local-service lifecycle, menus, deep links, updates |
| Desktop renderer | TypeScript/TSX | Next.js, React, Vercel AI SDK | Chat, streaming, generated UI, confirmations, task tray, browser pane |
| Shared contracts | TypeScript plus generated JSON Schema | Zod or equivalent | Canonical tool, IPC, bridge, event, and UI schemas |
| Orchestrator | TypeScript | Local Node/Next.js server runtime | Mistral loop, tool dispatch, policies, renderer streams |
| Browser service | Python 3.12+ | FastAPI, Nodriver, Pydantic, asyncio | Navigation, extraction, API discovery/invocation, actions, live view |
| Tests | TypeScript and Python | Vitest, Testing Library, Playwright, pytest | Unit, contract, integration, packaged-desktop, security, golden tests |
| State infrastructure | SQL/configuration | PostgreSQL, Redis | History, metadata, leases, task queue, rate limits |

Use strict TypeScript and typed Python. Keep contracts in one TypeScript source of truth and generate/check Python-compatible schema artifacts. Do not add another application language without an ADR covering packaging, security, ownership, and maintenance.

Recommended ownership:

```text
apps/desktop/       Electron main process and preload
apps/renderer/      Next.js/React desktop renderer
packages/contracts/ Canonical schemas and generated artifacts
packages/ui/        Theme tokens and shared UI primitives
services/browser/   Python/FastAPI/Nodriver service
docs/features/      Feature scope and implementation-location index
```

If existing code uses `apps/web`, treat it strictly as the renderer and rename it during Phase 0 when safe. Document retained legacy naming.

## Desktop security boundary

The runtime boundaries are Electron main, preload, renderer, and the Python browser service.

- Enable `contextIsolation`.
- Disable renderer `nodeIntegration`.
- Enable renderer sandboxing wherever compatible.
- Expose only a small typed preload API through `contextBridge`; never expose generic IPC, shell, filesystem, process, or command execution.
- Validate every IPC request and response with shared schemas.
- Deny unexpected navigation, new windows, permissions, downloads, uploads, and external protocols by default.
- Start and stop the loopback-only Python service from the main process.
- Generate a random per-launch service credential; never send it to the renderer, model, logs, or persistent storage.
- Package the Python service and browser runtime. Development-server success alone is not desktop completion.

Credentials, cookies, authenticated DOM, and browser profiles stay within the main/browser-service boundary. The renderer receives only bounded display data and opaque handles.

## UI theme

The visual direction is a calm, focused **AI workspace**, not a clone of traditional browser chrome. Chat is primary; generated results and the authentic browser are supporting context surfaces.

### Theme modes

- Support light and dark themes from the first UI phase.
- Default to the operating-system preference and persist a user override locally.
- Meet WCAG 2.2 AA contrast for text, controls, focus, and meaningful states.
- Never communicate success, warning, or failure using color alone.

### Semantic color tokens

Components must use semantic tokens, not raw colors.

| Token | Light | Dark | Purpose |
|---|---:|---:|---|
| `--color-bg-canvas` | `#F6F7F9` | `#0D1017` | Window background |
| `--color-bg-surface` | `#FFFFFF` | `#151A23` | Main panels |
| `--color-bg-elevated` | `#EEF1F5` | `#1D2430` | Cards and task surfaces |
| `--color-text-primary` | `#172033` | `#F3F6FC` | Primary text |
| `--color-text-secondary` | `#5C667A` | `#AAB4C5` | Metadata |
| `--color-border` | `#D9DEE8` | `#303949` | Borders and separators |
| `--color-accent` | `#5865F2` | `#8992FF` | Primary actions and active state |
| `--color-accent-hover` | `#4652D9` | `#A2A9FF` | Hover state |
| `--color-success` | `#16845B` | `#45C995` | Success |
| `--color-warning` | `#A15C00` | `#F2B85B` | Warnings and confirmation risk |
| `--color-danger` | `#C43D4B` | `#FF7A88` | Failure and destructive actions |
| `--color-focus` | `#2563EB` | `#8BB5FF` | Keyboard focus ring |

### Typography and geometry

- Use the operating-system sans-serif stack; bundled fonts must not be fetched remotely at runtime.
- Use the operating-system monospace stack for code, URLs, schemas, and technical identifiers.
- Base UI size is 14px; reading/chat content is 15-16px; auxiliary text must not be smaller than 12px.
- Use a 4px spacing grid with common values 4, 8, 12, 16, 24, and 32px.
- Standard controls are 40px high; compact controls are 36px; minimum target is 32x32px and 40x40px is preferred.
- Use 6px radius for controls, 10px for cards/panels, and 14px for overlays.
- Prefer borders and tonal separation to heavy shadows. Use 120-200ms motion and respect reduced-motion preferences.

## Desktop layout

The default window contains:

1. A title/navigation region with native drag handling, new task, history, active tasks, settings, and platform-appropriate window controls.
2. A primary conversation workspace with messages, citations, tool progress, and composer.
3. An optional resizable context pane for generated UI or the authentic live browser.
4. A collapsible task tray for concurrent work.

Use a recommended minimum of 1024x700 and provide a usable compact layout down to 800x600. The conversation must remain usable when the context pane disconnects. The context pane defaults to about 45% width. Label generated views as generated and the authentic pane as **Live website**, including its trusted origin. Sensitive confirmations remain visible in their owning task.

## Component behavior

- Stream text without disruptive layout shifts and use quiet, non-blocking progress states.
- Summarize tool activity by default and expose only safe expandable detail.
- Show inline citations with a source inspector and destination origin.
- Use the shared token/primitives package for all generated cards and tables.
- Visually frame embedded websites as external, untrusted content.
- Confirmation cards name site, account, exact effect, material values, risk, and expiry with distinct Confirm and Cancel controls.
- Errors say what failed, whether anything changed, and the safest recovery action.

## Validation

- Check completeness of theme tokens and prevent uncontrolled raw-color usage.
- Test light/dark themes, 200% zoom, reduced motion, keyboard-only operation, and screen-reader status announcements.
- Run visual snapshots at minimum, recommended, and wide desktop window sizes.
- Test Electron security configuration, preload allowlist, blocked renderer Node access, denied navigation/window creation, and loopback authentication.
- Run packaged desktop smoke tests, not only Next.js development-server tests.

This document is canonical for product form, language ownership, desktop boundaries, and UI theme. A feature may contradict it only through an approved ADR and an update to this document.
