"""Structured-log redaction shared by browser-service request logging."""

from __future__ import annotations

from typing import Any

REDACTED = "[REDACTED]"
SENSITIVE_KEYS = frozenset(
    {"authorization", "cookie", "set-cookie", "password", "secret", "token", "api_key", "apikey"}
)


def redact(value: Any) -> Any:
    """Return a recursively redacted copy suitable for structured logs."""
    if isinstance(value, dict):
        return {
            key: REDACTED if str(key).lower() in SENSITIVE_KEYS else redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, tuple):
        return tuple(redact(item) for item in value)
    return value
