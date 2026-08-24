"""Storage-agnostic domain models for inferred endpoint maps (P03-F02).

Every model here is a plain, immutable (frozen) dataclass built only from
structural/shape information -- never a raw header, cookie, query, or body
*value*. This mirrors the guarantee already made by
``browser_service.network.observation.SanitizedNetworkObservation``, the
only input this package consumes: field *names*, *counts*, *booleans*, and
*shape kinds* are the most granular data any model here is allowed to hold.

Site identity/approval is owned by a separate, parallel feature (site
governance); this package only ever references a site by its opaque
``site_id`` string, never by a resolved domain object.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from urllib.parse import urlsplit


class ApprovalState(StrEnum):
    """Lifecycle state of an :class:`EndpointMapVersion`.

    ``PENDING`` is the state every freshly inferred snapshot starts in --
    inference alone never produces an ``ACTIVE`` version. ``ACTIVE`` is
    reached only via the repository's explicit, auditable ``activate``
    operation. ``SUPERSEDED`` marks a version that was once active but has
    since been replaced by a later activation for the same site.
    """

    PENDING = "pending"
    ACTIVE = "active"
    SUPERSEDED = "superseded"


class DriftKind(StrEnum):
    REMOVED = "removed"
    STATUS_CHANGED = "status_changed"
    CONTENT_TYPE_CHANGED = "content_type_changed"
    PARAMETER_INCOMPATIBLE = "parameter_incompatible"
    RESPONSE_INCOMPATIBLE = "response_incompatible"


@dataclass(frozen=True)
class Site:
    site_id: str
    canonical_origin: str
    created_at: str

    def __post_init__(self) -> None:
        parsed = urlsplit(self.canonical_origin)
        if not self.site_id or parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("site requires an id and canonical HTTP(S) origin")


@dataclass(frozen=True)
class DriftAlert:
    operation_key: tuple[str, str, str]
    kinds: tuple[DriftKind, ...]


@dataclass(frozen=True)
class ActivationRecord:
    site_id: str
    version_id: str
    activated_at: str
    activated_by: str
    reason: str


@dataclass(frozen=True)
class FieldPresence:
    """A named field (query parameter or response header) plus whether it
    was observed on every contributing observation (``optional=False``) or
    only some of them (``optional=True``). Never carries a value."""

    name: str
    optional: bool


@dataclass(frozen=True)
class BodyShapeSchema:
    """Aggregate structural shape of a request/response body across a
    group of merged observations.

    ``kind`` is ``None`` when no observation in the group carried a body.
    Otherwise one of ``"object"``, ``"array"``, ``"primitive"``, ``"empty"``
    (mirrors ``BodyShape.kind``). ``keys`` is only meaningful when
    ``kind == "object"`` and lists top-level key names with their observed
    optionality -- never nested, never a value.
    """

    kind: str | None
    keys: tuple[FieldPresence, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class ParameterSchema:
    """Inferred request-side shape for a normalized operation."""

    query_parameters: tuple[FieldPresence, ...]
    request_body: BodyShapeSchema


@dataclass(frozen=True)
class ResponseSchema:
    """Inferred response-side shape for a normalized operation."""

    status_codes: tuple[int, ...]
    content_types: tuple[str, ...]
    body: BodyShapeSchema
    stable_headers: tuple[FieldPresence, ...]


@dataclass(frozen=True)
class NormalizedOperation:
    """One inferred method+origin+path-template endpoint."""

    method: str
    origin: str
    path_template: str
    parameters: ParameterSchema
    response: ResponseSchema
    confidence: float
    provenance: tuple[str, ...]
    last_seen: str
    stale: bool = False
    stale_reason: str | None = None

    @property
    def operation_key(self) -> tuple[str, str, str]:
        return (self.method, self.origin, self.path_template)

    def __post_init__(self) -> None:
        parsed = urlsplit(self.origin)
        if self.method != self.method.upper():
            raise ValueError("method must be uppercase")
        if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.path:
            raise ValueError("origin must be a normalized HTTP(S) origin")
        if not self.path_template.startswith("/") or not 0 <= self.confidence <= 1:
            raise ValueError("invalid path template or confidence")
        if tuple(sorted(set(self.provenance))) != self.provenance:
            raise ValueError("provenance must be sorted and unique")


@dataclass(frozen=True)
class EndpointMapVersion:
    """An immutable, versioned snapshot of every :class:`NormalizedOperation`
    inferred for a site as of ``created_at``.

    ``operations`` never changes after construction -- the *only* mutable
    aspect of a version's lifecycle is its ``approval_state`` (and the
    accompanying activation metadata), which moves from ``PENDING`` to
    ``ACTIVE`` (and later ``SUPERSEDED``) exclusively through the
    repository's explicit ``activate`` operation, never as a side effect of
    inference.
    """

    version_id: str
    site_id: str
    created_at: str
    operations: tuple[NormalizedOperation, ...]
    approval_state: ApprovalState = ApprovalState.PENDING
    activated_at: str | None = None
    activated_by: str | None = None
    activation_reason: str | None = None

    @property
    def is_active(self) -> bool:
        return self.approval_state is ApprovalState.ACTIVE

    def __post_init__(self) -> None:
        if not self.version_id or not self.site_id:
            raise ValueError("map version requires ids")
        keys = tuple(operation.operation_key for operation in self.operations)
        if keys != tuple(sorted(keys)) or len(keys) != len(set(keys)):
            raise ValueError("operations must be sorted and unique")
        activation_fields = (self.activated_at, self.activated_by, self.activation_reason)
        if self.is_active and any(value is None or value == "" for value in activation_fields):
            raise ValueError("active versions require complete activation metadata")
        if self.approval_state is ApprovalState.PENDING and any(
            value is not None for value in activation_fields
        ):
            raise ValueError("pending versions cannot carry activation metadata")


__all__ = [
    "ApprovalState",
    "ActivationRecord",
    "BodyShapeSchema",
    "DriftAlert",
    "DriftKind",
    "EndpointMapVersion",
    "FieldPresence",
    "NormalizedOperation",
    "ParameterSchema",
    "ResponseSchema",
    "Site",
]
