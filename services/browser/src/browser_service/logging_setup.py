"""Makes this service's structured log records actually readable.

Every module here already logs with ``extra={...}`` -- stage timings, typed
failure categories, correlation ids. Python's default formatter emits only
``record.getMessage()``, so all of it was being dropped: a timed-out
exploration reached the console as the bare event name
``browser_service.explore.timeout`` with no stage, no elapsed time, and no
correlation id, which is not enough to tell a slow navigation from an
exhausted capture budget.

This installs one formatter that appends the record's own non-standard
attributes as compact JSON, run through :func:`browser_service.redaction.redact`
so a key that should never be logged cannot become visible just because
extras now are. Nothing about what modules log changes -- only whether it
can be read.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from browser_service.redaction import redact

#: Attributes `logging.LogRecord` sets itself. Anything else on a record came
#: from a caller's `extra=` and is what this formatter exists to surface.
_STANDARD_RECORD_ATTRS = frozenset(
    {
        "args", "asctime", "created", "exc_info", "exc_text", "filename", "funcName",
        "levelname", "levelno", "lineno", "message", "module", "msecs", "msg", "name",
        "pathname", "process", "processName", "relativeCreated", "stack_info",
        "stacklevel", "taskName", "thread", "threadName",
    }
)

_MAX_EXTRA_CHARS = 4_000


class StructuredFormatter(logging.Formatter):
    """``LEVEL name: message {extras as JSON}``."""

    def format(self, record: logging.LogRecord) -> str:
        base = super().format(record)
        extras: dict[str, Any] = {
            key: value
            for key, value in record.__dict__.items()
            if key not in _STANDARD_RECORD_ATTRS and not key.startswith("_")
        }
        if not extras:
            return base
        try:
            rendered = json.dumps(redact(extras), default=str, ensure_ascii=False)
        except (TypeError, ValueError):
            rendered = repr(redact(extras))
        return f"{base} {rendered[:_MAX_EXTRA_CHARS]}"


def configure_logging(level: int = logging.INFO) -> None:
    """Installs the structured formatter on the root handler, idempotently.

    Called on application startup. Uvicorn configures the root handler
    before the app is imported, so this reformats whatever handlers exist
    rather than adding another one -- adding one would double every line.
    """
    root = logging.getLogger()
    formatter = StructuredFormatter("%(levelname)s %(name)s: %(message)s")
    if not root.handlers:
        root.addHandler(logging.StreamHandler())
    for handler in root.handlers:
        handler.setFormatter(formatter)
    logging.getLogger("browser_service").setLevel(level)


__all__ = ["StructuredFormatter", "configure_logging"]
