# browser-service

FastAPI service that will wrap [Nodriver](https://github.com/ultrafunkamsterdam/nodriver) to drive
live browser automation on behalf of the AI-Native Browser orchestrator. Phase 0 (P00-F01) only
provides environment scaffolding and health endpoints; see
`../../docs/features/p00-f01-monorepo-environment.md` for full details.

## Quick start

```sh
uv sync
uv run uvicorn browser_service.app:app --reload --port 8000
```

## Checks

```sh
uv run ruff check .
uv run mypy .
uv run pytest -q
```
