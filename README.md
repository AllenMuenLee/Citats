# AI-Native Browser

AI-Native Browser is an installable Electron desktop workspace with a Next.js/React chat renderer, a local TypeScript orchestration layer, and a Python FastAPI browser service. The chat loop streams from either Google Gemini or Groq -- each of its three model roles picks its provider independently.

## Prerequisites

- Node.js 20 or newer and npm
- Python 3.12 or newer
- [uv](https://docs.astral.sh/uv/getting-started/installation/)
- Docker Desktop with Docker Compose
- A Gemini API key, a Groq API key, or both (whichever providers you configure below)

Run all commands from the repository root unless a step says otherwise.

## Install

Install the JavaScript and Python dependencies:

```powershell
npm install
Set-Location services/browser
uv sync
Set-Location ../..
```

Start the local PostgreSQL and Redis containers:

```powershell
npm run compose:up
```

## Run locally on Windows

Development currently uses three terminals when testing the Python service separately. Choose a temporary browser-service token for local service health checks. Do not commit this token or a real provider API key.

Terminal 1 — browser service:

```powershell
Set-Location services/browser
$env:BROWSER_SERVICE_TOKEN = "local-dev-token"
$env:POSTGRES_HOST = "localhost"
$env:POSTGRES_PORT = "5432"
$env:REDIS_HOST = "localhost"
$env:REDIS_PORT = "6379"
uv run uvicorn browser_service.app:app --reload --host 127.0.0.1 --port 8000
```

Terminal 2 — renderer and local orchestrator:

```powershell
$env:GEMINI_API_KEY = "your-gemini-api-key"
$env:CHAT_MODEL_PROVIDER = "Gemini"
$env:CHAT_MODEL = "gemini-3.5-flash"
npm run dev --workspace apps/renderer
```

The renderer reads its full configuration from `apps/renderer/.env` (see
`apps/renderer/.env.example`). Three model roles are configured independently, and each
one picks `Gemini` or `Groq`:

| Role | Variables | Purpose |
| --- | --- | --- |
| Chat | `CHAT_MODEL_PROVIDER`, `CHAT_MODEL` | Answers the user, runs the hosted online search, calls the local tools. Required. |
| Extraction | `EXTRACTION_MODEL_PROVIDER`, `EXTRACTION_MODEL` | Turns one rendered page observation into the digest a generative-UI plan is built from. Optional. |
| UI | `UI_MODEL_PROVIDER`, `UI_MODEL` | Writes the final React component. Optional; generative UI is disabled without it. |

Set `GEMINI_API_KEY` and/or `GROQ_API_KEY` for whichever providers those roles name.

Terminal 3 — Electron desktop:

```powershell
npm run build --workspace apps/desktop
npm run dev --workspace apps/desktop
```

The Electron window loads the renderer from `http://localhost:3000`. Enter a chat message to test a direct streaming response. To exercise the stub tool loop, ask the assistant to use `system.echo` to echo a short message.

The Electron development process also starts its own authenticated browser-service child for desktop lifecycle testing. The provider's hosted web search runs through the trusted Next.js server and does not use the Python browser service.

## Check the browser service

The liveness endpoint does not require authentication:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health/live
```

Readiness and tool endpoints require the shared token:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health/ready -Headers @{ "X-Service-Token" = "local-dev-token" }
```

## Validate the project

```powershell
npm run typecheck
npm run lint
npm test
```

## Build and run the packaged desktop app

Set a provider key in the shell, build the unpacked Windows application, and launch it:

```powershell
$env:GEMINI_API_KEY = "your-gemini-api-key"
npm run package
& ".\apps\desktop\release\win-unpacked\AI-Native Browser.exe"
```

The packaged desktop generates its own per-launch browser-service credential and passes it only to trusted local processes. The current package includes the Python service source but not a standalone Python/uv runtime, so `uv` must remain installed on the test machine.

## Stop local infrastructure

Stop the renderer, browser service, and Electron processes with `Ctrl+C` in their terminals, then stop the containers:

```powershell
npm run compose:down
```

## Common setup problems

- `The local AI service is not configured`: confirm Terminal 2 has `CHAT_MODEL_PROVIDER`, `CHAT_MODEL`, and that provider's API key set before starting Next.js.
- Browser-service requests return `401`: confirm the request uses the same token configured in Terminal 1.
- Electron opens and immediately exits: confirm the renderer is already listening on port 3000 and `uv` is available on `PATH`.
- Ports 3000 or 8000 are occupied: stop the conflicting process before starting the development stack.
