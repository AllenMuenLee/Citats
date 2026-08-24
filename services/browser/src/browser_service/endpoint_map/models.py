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
from enum import Enum


class ApprovalState(str, Enum):
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


__all__ = [
    "ApprovalState",
    "BodyShapeSchema",
    "EndpointMapVersion",
    "FieldPresence",
    "NormalizedOperation",
    "ParameterSchema",
    "ResponseSchema",
]
