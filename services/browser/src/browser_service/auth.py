"""Local-service authentication for services/browser.

apps/desktop's Electron main process generates a random per-launch
credential and passes it to this service as the ``BROWSER_SERVICE_TOKEN``
environment variable when it spawns the ``uvicorn`` child process (see
docs/desktop-architecture-and-ui-specification.md, "Generate a random
per-launch service credential"). Every route other than the pure liveness
probe (``/health/live``) must require this credential as the
``X-Service-Token`` request header, via the ``require_service_token``
dependency below.

``/health/live`` stays unauthenticated by design: it is a pure "is the
process up and serving requests at all" liveness probe with no information
disclosure (a fixed ``{"status": "live"}``), so gating it behind auth would
only complicate process-supervisor liveness checks for no security benefit.
Every other route -- starting with ``/health/ready``, and every route a
later phase adds -- must depend on this.
"""

from __future__ import annotations

import os
import secrets

from fastapi import Header, HTTPException, status

SERVICE_TOKEN_ENV_VAR = "BROWSER_SERVICE_TOKEN"


def _get_expected_token() -> str | None:
    value = os.environ.get(SERVICE_TOKEN_ENV_VAR)
    if value is None or value.strip() == "":
        return None
    return value


async def require_service_token(
    x_service_token: str | None = Header(default=None, alias="X-Service-Token"),
) -> None:
    """FastAPI dependency requiring a valid ``X-Service-Token`` header.

    Returns 401 with no body detail (never echoes the expected or received
    token, and never distinguishes "missing header" from "wrong token" in
    the response) on any failure, including when the service was started
    without ``BROWSER_SERVICE_TOKEN`` set at all -- an unconfigured service
    refuses every authenticated request rather than failing open.
    """
    expected = _get_expected_token()
    is_valid = (
        expected is not None
        and x_service_token is not None
        and secrets.compare_digest(x_service_token, expected)
    )
    if not is_valid:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
