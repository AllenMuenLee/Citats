"""The structured formatter is what makes every ``extra={...}`` readable."""

from __future__ import annotations

import json
import logging

from browser_service.logging_setup import StructuredFormatter, configure_logging


def _record(**extra: object) -> logging.LogRecord:
    record = logging.LogRecord(
        name="browser_service.tools.explore_website",
        level=logging.WARNING,
        pathname=__file__,
        lineno=1,
        msg="browser_service.explore.timeout",
        args=(),
        exc_info=None,
    )
    for key, value in extra.items():
        setattr(record, key, value)
    return record


def test_extras_are_appended_as_json() -> None:
    formatted = StructuredFormatter("%(levelname)s %(name)s: %(message)s").format(
        _record(requestId="req-1", stage="capture_document_unavailable", elapsedSeconds=6.27)
    )
    head, _, payload = formatted.partition(" {")
    assert head == "WARNING browser_service.tools.explore_website: browser_service.explore.timeout"
    assert json.loads("{" + payload) == {
        "requestId": "req-1",
        "stage": "capture_document_unavailable",
        "elapsedSeconds": 6.27,
    }


def test_a_record_without_extras_is_left_alone() -> None:
    assert StructuredFormatter("%(message)s").format(_record()) == "browser_service.explore.timeout"


def test_sensitive_extras_are_redacted_rather_than_newly_exposed() -> None:
    record = _record(token="s3cret", stage="navigation")
    formatted = StructuredFormatter("%(message)s").format(record)
    assert "s3cret" not in formatted
    assert "[REDACTED]" in formatted


def test_unserializable_extras_never_raise() -> None:
    formatted = StructuredFormatter("%(message)s").format(_record(page=object()))
    assert "browser_service.explore.timeout" in formatted


def test_configure_logging_is_idempotent_and_adds_no_duplicate_handlers() -> None:
    root = logging.getLogger()
    before = list(root.handlers)
    try:
        configure_logging()
        count = len(root.handlers)
        configure_logging()
        assert len(root.handlers) == count
        assert all(isinstance(handler.formatter, StructuredFormatter) for handler in root.handlers)
    finally:
        root.handlers = before
