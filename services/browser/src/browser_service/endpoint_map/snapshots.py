from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, replace
from datetime import UTC, datetime
from typing import Any

from browser_service.endpoint_map.models import (
    DriftAlert,
    DriftKind,
    EndpointMapVersion,
    FieldPresence,
    NormalizedOperation,
)


def _canonical_operations(operations: tuple[NormalizedOperation, ...]) -> list[dict[str, Any]]:
    ordered = sorted(operations, key=lambda item: item.operation_key)
    return [asdict(operation) for operation in ordered]


def create_snapshot(
    site_id: str,
    operations: tuple[NormalizedOperation, ...],
    *,
    created_at: str | None = None,
) -> EndpointMapVersion:
    ordered = tuple(sorted(operations, key=lambda item: item.operation_key))
    payload = json.dumps(
        {"site_id": site_id, "operations": _canonical_operations(ordered)},
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return EndpointMapVersion(
        version_id=hashlib.sha256(payload).hexdigest(),
        site_id=site_id,
        created_at=created_at or datetime.now(UTC).isoformat(),
        operations=ordered,
    )


def _fields_compatible(old: tuple[FieldPresence, ...], new: tuple[FieldPresence, ...]) -> bool:
    new_by_name = {field.name: field for field in new}
    return all(
        field.optional or (field.name in new_by_name and not new_by_name[field.name].optional)
        for field in old
    )


def _parameter_compatible(old: NormalizedOperation, new: NormalizedOperation) -> bool:
    if not _fields_compatible(old.parameters.query_parameters, new.parameters.query_parameters):
        return False
    old_body = old.parameters.request_body
    new_body = new.parameters.request_body
    return old_body.kind == new_body.kind and _fields_compatible(old_body.keys, new_body.keys)


def _response_compatible(old: NormalizedOperation, new: NormalizedOperation) -> bool:
    old_body = old.response.body
    new_body = new.response.body
    return old_body.kind == new_body.kind and _fields_compatible(old_body.keys, new_body.keys)


def compare_with_active(
    candidate: EndpointMapVersion, active: EndpointMapVersion | None
) -> tuple[EndpointMapVersion, tuple[DriftAlert, ...]]:
    if active is None:
        return candidate, ()
    if candidate.site_id != active.site_id:
        raise ValueError("cannot compare endpoint maps for different sites")
    active_by_key = {operation.operation_key: operation for operation in active.operations}
    candidate_by_key = {operation.operation_key: operation for operation in candidate.operations}
    alerts: list[DriftAlert] = []
    changed: list[NormalizedOperation] = []
    for key in sorted(active_by_key):
        old = active_by_key[key]
        new = candidate_by_key.get(key)
        kinds: list[DriftKind] = []
        if new is None:
            alerts.append(DriftAlert(key, (DriftKind.REMOVED,)))
            continue
        if old.response.status_codes != new.response.status_codes:
            kinds.append(DriftKind.STATUS_CHANGED)
        if old.response.content_types != new.response.content_types:
            kinds.append(DriftKind.CONTENT_TYPE_CHANGED)
        if not _parameter_compatible(old, new):
            kinds.append(DriftKind.PARAMETER_INCOMPATIBLE)
        if not _response_compatible(old, new):
            kinds.append(DriftKind.RESPONSE_INCOMPATIBLE)
        if kinds:
            reason = ",".join(kind.value for kind in kinds)
            new = replace(new, stale=True, stale_reason=reason)
            alerts.append(DriftAlert(key, tuple(kinds)))
        changed.append(new)
    changed.extend(
        operation for key, operation in candidate_by_key.items() if key not in active_by_key
    )
    operations = tuple(sorted(changed, key=lambda item: item.operation_key))
    compared = replace(candidate, operations=operations)
    return compared, tuple(alerts)


__all__ = ["compare_with_active", "create_snapshot"]
