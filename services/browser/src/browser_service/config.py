"""Environment-derived configuration for the browser service.

Phase 0 scope: only the connection *coordinates* needed for health checks
(host/port) are read here. Credentials (passwords, API keys) are
intentionally NOT read or exposed by this module or by the health
endpoints -- secret values must never reach LLM context, logs, or HTTP
responses. Full DB/queue client configuration belongs to later phases that
actually use Postgres/Redis for reads and writes.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class DependencyTarget:
    """Host/port coordinates for a single dependency, with no credentials."""

    host: str | None
    port: int | None

    @property
    def configured(self) -> bool:
        return bool(self.host) and self.port is not None


def _read_port(name: str) -> int | None:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def get_postgres_target() -> DependencyTarget:
    return DependencyTarget(
        host=os.environ.get("POSTGRES_HOST"),
        port=_read_port("POSTGRES_PORT"),
    )


def get_redis_target() -> DependencyTarget:
    return DependencyTarget(
        host=os.environ.get("REDIS_HOST"),
        port=_read_port("REDIS_PORT"),
    )
