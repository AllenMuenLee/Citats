"""The sanitized-observation contract between network capture (this package,
P03-F01) and endpoint inference (``browser_service.endpoint_map``, P03-F02).

This module defines shape only -- no capture/redaction logic lives here (see
``capture.py``/``sanitizer.py``/``redactor.py``) -- so both features can be
built against a fixed, agreed contract without waiting on each other.
Nothing on this type ever carries an original secret value: string/query/body
fields are already redacted or reduced to structural (type/shape) descriptors
by the time an observation is constructed. See ``redactor.py`` for the
default-deny redaction this feeds from.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


class InitiatorCategory(StrEnum):
    """Coarse classification of what triggered a captured request (mirrors
    CDP ``Network.Initiator.type``, collapsed to the categories the mapper
    actually needs)."""

    SCRIPT = "script"
    PARSER = "parser"
    PRELOAD = "preload"
    OTHER = "other"


@dataclass(frozen=True)
class BodyShape:
    """A structural (never value-bearing) descriptor of a JSON/form body.

    ``kind`` is one of ``"object"``, ``"array"``, ``"primitive"``, or
    ``"empty"``. ``keys`` holds top-level object key names only (never
    nested, never values) when ``kind == "object"``; empty otherwise.
    """

    kind: str
    keys: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class SanitizedNetworkObservation:
    """One redacted, bounded, already-sanitized XHR/fetch observation.

    Constructing one of these is the *only* way raw CDP request/response
    data may cross from ``network/`` capture into the rest of the service
    (e.g. ``endpoint_map``) -- nothing upstream of this type is ever passed
    along unredacted.
    """

    observation_id: str
    task_id: str
    session_id: str | None
    captured_at: str  # ISO 8601 UTC timestamp

    method: str
    origin: str  # scheme://host[:port], normalized lowercase
    path: str  # normalized, no query string
    query_keys: tuple[str, ...]  # key names only, values redacted/dropped
    same_origin: bool  # relative to the page's own navigated origin

    status: int | None
    content_type: str | None
    timing_ms: float | None
    initiator: InitiatorCategory

    request_body_shape: BodyShape | None
    response_body_shape: BodyShape | None
    stable_response_headers: tuple[str, ...]  # header *names* only

    redacted: bool  # true if any field was redacted from its raw form
    truncated: bool  # true if any field/body was capped before sanitizing


__all__ = [
    "BodyShape",
    "InitiatorCategory",
    "SanitizedNetworkObservation",
]
