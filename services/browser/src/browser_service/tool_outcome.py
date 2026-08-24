"""Shared result/error shapes every tool handler in `tool_registry.TOOL_REGISTRY` uses.

Kept separate from `tool_registry.py` so `browser_service.tools.*` modules
(which handlers themselves live in) can import these without importing
the registry itself.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# Mirrors `ErrorResult.errorCode`'s Literal values (see
# `browser_service.contracts.generated.error_result`) -- kept as a plain
# literal set here rather than introspected from the generated model so
# this stays a simple, staticly-typeable membership check.
VALID_TOOL_ERROR_CODES = frozenset(
    {
        "INVALID_ARGUMENTS",
        "UNKNOWN_TOOL",
        "TIMEOUT",
        "CANCELLED",
        "UPSTREAM_UNAVAILABLE",
        "POLICY_BLOCKED",
        "STALE_MAP",
        "RESPONSE_DRIFT",
        "RATE_LIMITED",
        "INTERNAL",
    }
)


@dataclass(frozen=True)
class ToolHandlerOutcome:
    """A tool handler's successful result: the tool-specific `payload`
    (already shaped exactly as that tool's success-result schema expects,
    camelCase field names included) plus optional bounded `evidence`
    items (see `packages/contracts/src/evidence.ts`)."""

    payload: dict[str, Any]
    evidence: list[dict[str, Any]] | None = None


class ToolExecutionError(Exception):
    """A typed, safe-to-surface tool failure.

    `code` must be one of `ErrorResult`'s generated `errorCode` literal
    values (validated below, so a typo fails immediately at raise time
    rather than surfacing as a confusing contract-validation error deep
    in the response path). `message` must never contain a raw
    exception/stack trace -- callers are responsible for mapping internal
    detail to a short, safe summary before raising this.
    """

    def __init__(self, code: str, message: str, *, retryable: bool) -> None:
        if code not in VALID_TOOL_ERROR_CODES:
            raise ValueError(f"'{code}' is not a valid ToolErrorCode")
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


__all__ = ["ToolExecutionError", "ToolHandlerOutcome"]
