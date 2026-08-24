"""Glues raw captured request/response data to exactly one
:class:`~browser_service.network.observation.SanitizedNetworkObservation`,
or discards it.

``sanitize_exchange`` is the single choke point every raw CDP
request/response record must pass through: everything it returns is
already bounded and default-deny redacted (see ``redactor.py``), and it
returns ``None`` outright for anything that must never be even partially
recorded (non-XHR/Fetch resource types, binary bodies, websocket/media/font
traffic) rather than emitting a partial observation for those.
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import parse_qsl, urlsplit

from browser_service.network.observation import (
    BodyShape,
    InitiatorCategory,
    SanitizedNetworkObservation,
)
from browser_service.network.redactor import (
    redact_body_mapping,
    redact_field_names,
    redact_response_header_names,
)

logger = logging.getLogger("browser_service.network.sanitizer")

# Resource types (CDP Network.ResourceType string values) this feature
# captures at all. Everything else (Document, Stylesheet, Image, Media,
# Font, Script, WebSocket, ...) is discarded entirely, never partially
# recorded.
CAPTURED_RESOURCE_TYPES = frozenset({"XHR", "Fetch"})

_TEXT_CONTENT_TYPE_PREFIXES = (
    "application/json",
    "application/ld+json",
    "application/x-www-form-urlencoded",
    "application/xml",
    "text/",
)

_DEFAULT_PORTS = {"http": 80, "https": 443}

MAX_QUERY_KEYS = 25
MAX_BODY_KEYS = 50
MAX_RESPONSE_HEADERS = 20
MAX_BODY_SAMPLE_BYTES = 200_000
MAX_CONTENT_TYPE_LENGTH = 256


@dataclass(frozen=True)
class SanitizerLimits:
    """Per-field/body/event caps applied while building an observation."""

    max_query_keys: int = MAX_QUERY_KEYS
    max_body_keys: int = MAX_BODY_KEYS
    max_response_headers: int = MAX_RESPONSE_HEADERS
    max_body_sample_bytes: int = MAX_BODY_SAMPLE_BYTES
    max_content_type_length: int = MAX_CONTENT_TYPE_LENGTH


DEFAULT_LIMITS = SanitizerLimits()


@dataclass(frozen=True)
class RawExchange:
    """One finished raw CDP request/response record, still unsanitized.

    Lives only in task-local memory (see ``capture.py``) for exactly as
    long as it takes to build this and hand it to :func:`sanitize_exchange`
    -- nothing here is ever logged or persisted as-is.
    """

    request_id: str
    method: str
    url: str
    resource_type: str | None
    initiator_type: str
    status: int | None
    response_content_type: str | None
    response_header_names: tuple[str, ...]
    request_timestamp: float | None
    finished_timestamp: float | None
    wall_time: float | None
    request_body_text: str | None = None
    request_content_type: str | None = None
    response_body_text: str | None = None


def _map_initiator(initiator_type: str) -> InitiatorCategory:
    lowered = initiator_type.strip().lower()
    if lowered == "script":
        return InitiatorCategory.SCRIPT
    if lowered == "parser":
        return InitiatorCategory.PARSER
    if lowered == "preload":
        return InitiatorCategory.PRELOAD
    return InitiatorCategory.OTHER


def _is_text_like_content_type(content_type: str) -> bool:
    base = content_type.split(";", 1)[0].strip().lower()
    if not base:
        return True  # unknown -- treated as text-like, not discarded outright
    return any(base.startswith(prefix) for prefix in _TEXT_CONTENT_TYPE_PREFIXES)


def normalize_origin(url: str) -> str | None:
    """Normalize ``url`` to ``scheme://host[:port]`` lowercase, or ``None``
    if it has no meaningful scheme/host (e.g. ``about:blank``, ``data:``).
    """
    parts = urlsplit(url)
    scheme = parts.scheme.lower()
    host = parts.hostname
    if not scheme or not host:
        return None
    host = host.lower()
    port = parts.port
    if port is not None and port != _DEFAULT_PORTS.get(scheme):
        return f"{scheme}://{host}:{port}"
    return f"{scheme}://{host}"


@dataclass(frozen=True)
class _BodyResult:
    shape: BodyShape | None
    redacted: bool
    truncated: bool


_EMPTY_BODY = _BodyResult(BodyShape(kind="empty"), False, False)


def _build_body_shape(
    raw_text: str | None, content_type: str | None, limits: SanitizerLimits
) -> _BodyResult:
    if raw_text is None or raw_text == "":
        return _EMPTY_BODY

    truncated = False
    encoded = raw_text.encode("utf-8", errors="ignore")
    if len(encoded) > limits.max_body_sample_bytes:
        raw_text = encoded[: limits.max_body_sample_bytes].decode("utf-8", errors="ignore")
        truncated = True

    is_form = content_type is not None and "x-www-form-urlencoded" in content_type.lower()
    try:
        if is_form:
            parsed: object = dict(parse_qsl(raw_text, keep_blank_values=True))
        else:
            parsed = json.loads(raw_text)
    except (ValueError, UnicodeDecodeError):
        return _BodyResult(BodyShape(kind="primitive"), False, truncated)

    if isinstance(parsed, dict):
        result = redact_body_mapping(parsed, max_fields=limits.max_body_keys)
        return _BodyResult(
            BodyShape(kind="object", keys=result.kept_names),
            result.redacted,
            truncated or result.truncated,
        )
    if isinstance(parsed, list):
        return _BodyResult(BodyShape(kind="array"), False, truncated)
    return _BodyResult(BodyShape(kind="primitive"), False, truncated)


def sanitize_exchange(
    raw: RawExchange,
    *,
    task_id: str,
    session_id: str | None,
    page_origin: str | None,
    limits: SanitizerLimits = DEFAULT_LIMITS,
) -> SanitizedNetworkObservation | None:
    """Build one :class:`SanitizedNetworkObservation` from ``raw``, or
    return ``None`` if this exchange must not be recorded at all.
    """
    if raw.resource_type not in CAPTURED_RESOURCE_TYPES:
        return None

    content_type = raw.response_content_type
    if content_type and not _is_text_like_content_type(content_type):
        # Binary/media/font-shaped response body -- skip entirely, never
        # partially recorded.
        return None

    origin = normalize_origin(raw.url)
    if origin is None:
        return None
    same_origin = page_origin is not None and origin == page_origin

    parts = urlsplit(raw.url)
    path = parts.path or "/"

    query_result = redact_field_names(
        parse_qsl(parts.query, keep_blank_values=True), max_fields=limits.max_query_keys
    )

    header_result = redact_response_header_names(
        raw.response_header_names, max_headers=limits.max_response_headers
    )

    request_body = _build_body_shape(raw.request_body_text, raw.request_content_type, limits)
    response_body = _build_body_shape(raw.response_body_text, content_type, limits)

    timing_ms: float | None = None
    if raw.request_timestamp is not None and raw.finished_timestamp is not None:
        delta = raw.finished_timestamp - raw.request_timestamp
        if delta >= 0:
            timing_ms = delta * 1000.0

    if raw.wall_time is not None:
        captured_at = datetime.fromtimestamp(raw.wall_time, tz=UTC).isoformat()
    else:
        captured_at = datetime.now(tz=UTC).isoformat()

    truncated_content_type = content_type
    if truncated_content_type is not None and len(truncated_content_type) > limits.max_content_type_length:
        truncated_content_type = truncated_content_type[: limits.max_content_type_length]

    redacted = query_result.redacted or header_result.redacted or request_body.redacted or response_body.redacted
    truncated = query_result.truncated or header_result.truncated or request_body.truncated or response_body.truncated

    try:
        return SanitizedNetworkObservation(
            observation_id=str(uuid.uuid4()),
            task_id=task_id,
            session_id=session_id,
            captured_at=captured_at,
            method=raw.method.upper(),
            origin=origin,
            path=path,
            query_keys=query_result.kept_names,
            same_origin=same_origin,
            status=raw.status,
            content_type=truncated_content_type,
            timing_ms=timing_ms,
            initiator=_map_initiator(raw.initiator_type),
            request_body_shape=request_body.shape,
            response_body_shape=response_body.shape,
            stable_response_headers=header_result.kept_names,
            redacted=redacted,
            truncated=truncated,
        )
    except Exception:  # noqa: BLE001 -- never let a construction failure leak partial/raw state
        logger.warning(
            "browser_service.network.sanitize_construction_failed",
            extra={"resource_type": raw.resource_type},
            exc_info=True,
        )
        return None


__all__ = [
    "CAPTURED_RESOURCE_TYPES",
    "DEFAULT_LIMITS",
    "RawExchange",
    "SanitizerLimits",
    "normalize_origin",
    "sanitize_exchange",
]
