"""FastAPI entry point for the browser automation service.

Phase 0 scope: this module wires health endpoints and the authenticated
``system.echo`` contract harness. It does not implement Nodriver browsing
or CDP session management.

``/health/ready`` requires the ``X-Service-Token`` header (see auth.py);
``/health/live`` is a deliberately unauthenticated pure liveness probe.
"""

from __future__ import annotations

import logging

from fastapi import Depends, FastAPI
from starlette.middleware.base import RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

from browser_service.api.bridge import router as bridge_router
from browser_service.auth import require_service_token
from browser_service.config import get_postgres_target, get_redis_target
from browser_service.health import check_tcp_reachable

app = FastAPI(
    title="AI-Native Browser - Browser Service",
    description=(
        "Python FastAPI service that will wrap Nodriver to drive live "
        "browser automation on behalf of the orchestrator. Phase 0 only "
        "provides environment scaffolding and health endpoints."
    ),
    version="0.1.0",
)

app.include_router(bridge_router)
logger = logging.getLogger("browser_service.http")


@app.middleware("http")
async def correlation_logging(request: Request, call_next: RequestResponseEndpoint) -> Response:
    """Log bounded transport metadata without bodies, credentials, or query strings."""
    request_id = request.headers.get("X-Request-Id", "unassigned")[:128]
    response = await call_next(request)
    logger.info(
        "browser_service.request",
        extra={
            "request_id": request_id,
            "method": request.method,
            "path": request.url.path,
            "status_code": response.status_code,
        },
    )
    response.headers["X-Request-Id"] = request_id
    return response


@app.get("/health/live")
async def health_live() -> dict[str, str]:
    """Trivial liveness probe: process is up and serving requests."""
    return {"status": "live"}


@app.get("/health/ready", dependencies=[Depends(require_service_token)])
async def health_ready() -> dict[str, object]:
    """Readiness probe: reports reachability of configured dependencies.

    Requires a valid ``X-Service-Token`` header (see auth.py) -- returns 401
    with no body detail if missing/wrong/unconfigured before this body is
    ever built. Never includes hostnames, ports, connection strings, or
    credentials in the response body -- only the component name and an
    "up"/"down"/"unknown" status.
    """
    postgres_status = await check_tcp_reachable(get_postgres_target())
    redis_status = await check_tcp_reachable(get_redis_target())

    components = {
        "postgres": postgres_status,
        "redis": redis_status,
    }
    overall_ready = all(status == "up" for status in components.values())

    return {
        "status": "ready" if overall_ready else "not_ready",
        "components": components,
    }
