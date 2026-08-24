from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import asdict, replace
from datetime import UTC, datetime
from typing import Any, Protocol, cast

from browser_service.endpoint_map.models import (
    ActivationRecord,
    ApprovalState,
    BodyShapeSchema,
    EndpointMapVersion,
    FieldPresence,
    NormalizedOperation,
    ParameterSchema,
    ResponseSchema,
    Site,
)


class EndpointMapRepository(Protocol):
    async def save_site(self, site: Site) -> None: ...

    async def save_version(self, version: EndpointMapVersion) -> None: ...

    async def get_version(self, version_id: str) -> EndpointMapVersion | None: ...

    async def get_active(self, site_id: str) -> EndpointMapVersion | None: ...

    async def list_active(self) -> tuple[EndpointMapVersion, ...]: ...

    async def activate(
        self, site_id: str, version_id: str, *, actor: str, reason: str
    ) -> EndpointMapVersion: ...

    async def activation_history(self, site_id: str) -> tuple[ActivationRecord, ...]: ...


class InMemoryEndpointMapRepository:
    def __init__(self) -> None:
        self._sites: dict[str, Site] = {}
        self._versions: dict[str, EndpointMapVersion] = {}
        self._active: dict[str, str] = {}
        self._audit: list[ActivationRecord] = []

    async def save_site(self, site: Site) -> None:
        existing = self._sites.get(site.site_id)
        if existing is not None and existing.canonical_origin != site.canonical_origin:
            raise ValueError("site records are immutable")
        if existing is None:
            self._sites[site.site_id] = site

    async def save_version(self, version: EndpointMapVersion) -> None:
        if version.site_id not in self._sites:
            raise KeyError("unknown site")
        existing = self._versions.get(version.version_id)
        if existing is not None and existing != version:
            raise ValueError("map versions are immutable")
        self._versions[version.version_id] = version

    async def get_version(self, version_id: str) -> EndpointMapVersion | None:
        return self._versions.get(version_id)

    async def get_active(self, site_id: str) -> EndpointMapVersion | None:
        version_id = self._active.get(site_id)
        return self._versions.get(version_id) if version_id else None

    async def list_active(self) -> tuple[EndpointMapVersion, ...]:
        return tuple(
            sorted(
                (self._versions[version_id] for version_id in self._active.values()),
                key=lambda version: version.site_id,
            )
        )

    async def activate(
        self, site_id: str, version_id: str, *, actor: str, reason: str
    ) -> EndpointMapVersion:
        if not actor.strip() or not reason.strip():
            raise ValueError("activation requires actor and reason")
        pending = self._versions.get(version_id)
        if pending is None or pending.site_id != site_id:
            raise KeyError("map version not found for site")
        if any(operation.stale for operation in pending.operations):
            raise ValueError("stale map versions cannot be activated")
        if pending.approval_state is not ApprovalState.PENDING:
            raise ValueError("only pending map versions can be activated")
        timestamp = datetime.now(UTC).isoformat()
        previous_id = self._active.get(site_id)
        if previous_id:
            self._versions[previous_id] = replace(
                self._versions[previous_id], approval_state=ApprovalState.SUPERSEDED
            )
        active = replace(
            pending,
            approval_state=ApprovalState.ACTIVE,
            activated_at=timestamp,
            activated_by=actor,
            activation_reason=reason,
        )
        self._versions[version_id] = active
        self._active[site_id] = version_id
        self._audit.append(ActivationRecord(site_id, version_id, timestamp, actor, reason))
        return active

    async def activation_history(self, site_id: str) -> tuple[ActivationRecord, ...]:
        return tuple(record for record in self._audit if record.site_id == site_id)


def _field(data: Mapping[str, Any]) -> FieldPresence:
    return FieldPresence(name=str(data["name"]), optional=bool(data["optional"]))


def _body(data: Mapping[str, Any]) -> BodyShapeSchema:
    kind = data.get("kind")
    return BodyShapeSchema(
        kind=str(kind) if kind is not None else None,
        keys=tuple(_field(item) for item in cast(list[Mapping[str, Any]], data.get("keys", []))),
    )


def _operation(data: Mapping[str, Any]) -> NormalizedOperation:
    parameters = cast(Mapping[str, Any], data["parameters"])
    response = cast(Mapping[str, Any], data["response"])
    return NormalizedOperation(
        method=str(data["method"]),
        origin=str(data["origin"]),
        path_template=str(data["path_template"]),
        parameters=ParameterSchema(
            query_parameters=tuple(
                _field(item)
                for item in cast(list[Mapping[str, Any]], parameters["query_parameters"])
            ),
            request_body=_body(cast(Mapping[str, Any], parameters["request_body"])),
        ),
        response=ResponseSchema(
            status_codes=tuple(int(item) for item in cast(list[int], response["status_codes"])),
            content_types=tuple(str(item) for item in cast(list[str], response["content_types"])),
            body=_body(cast(Mapping[str, Any], response["body"])),
            stable_headers=tuple(
                _field(item)
                for item in cast(list[Mapping[str, Any]], response["stable_headers"])
            ),
        ),
        confidence=float(data["confidence"]),
        provenance=tuple(str(item) for item in cast(list[str], data["provenance"])),
        last_seen=str(data["last_seen"]),
        stale=bool(data.get("stale", False)),
        stale_reason=str(data["stale_reason"]) if data.get("stale_reason") is not None else None,
    )


def _version_from_row(row: Mapping[str, Any]) -> EndpointMapVersion:
    payload = row["operations"]
    raw_operations = json.loads(payload) if isinstance(payload, str) else payload
    return EndpointMapVersion(
        version_id=str(row["version_id"]),
        site_id=str(row["site_id"]),
        created_at=str(row["created_at"]),
        operations=tuple(
            _operation(item) for item in cast(list[Mapping[str, Any]], raw_operations)
        ),
        approval_state=ApprovalState(str(row["approval_state"])),
        activated_at=str(row["activated_at"]) if row["activated_at"] is not None else None,
        activated_by=str(row["activated_by"]) if row["activated_by"] is not None else None,
        activation_reason=(
            str(row["activation_reason"]) if row["activation_reason"] is not None else None
        ),
    )


class PostgresEndpointMapRepository:
    def __init__(self, pool: Any) -> None:
        self._pool = pool

    async def save_site(self, site: Site) -> None:
        await self._pool.execute(
            "INSERT INTO endpoint_map_sites(site_id, canonical_origin, created_at) "
            "VALUES($1,$2,$3) "
            "ON CONFLICT (site_id) DO NOTHING",
            site.site_id,
            site.canonical_origin,
            site.created_at,
        )

    async def save_version(self, version: EndpointMapVersion) -> None:
        operations = json.dumps([asdict(operation) for operation in version.operations])
        async with self._pool.acquire() as connection, connection.transaction():
            result = await connection.execute(
                "INSERT INTO endpoint_map_versions"
                "(version_id,site_id,created_at,operations,approval_state) "
                "VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT (version_id) DO NOTHING",
                version.version_id,
                version.site_id,
                version.created_at,
                operations,
                version.approval_state.value,
            )
            if result != "INSERT 0 0":
                for index, operation in enumerate(version.operations):
                    await connection.execute(
                        "INSERT INTO endpoint_map_operations"
                        "(version_id,operation_index,method,origin,path_template,parameter_schema,"
                        "response_schema,confidence,stale,stale_reason,last_seen) "
                        "VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11)",
                        version.version_id,
                        index,
                        operation.method,
                        operation.origin,
                        operation.path_template,
                        json.dumps(asdict(operation.parameters)),
                        json.dumps(asdict(operation.response)),
                        operation.confidence,
                        operation.stale,
                        operation.stale_reason,
                        operation.last_seen,
                    )
                    for observation_id in operation.provenance:
                        await connection.execute(
                            "INSERT INTO endpoint_map_observation_provenance"
                            "(version_id,operation_index,observation_id) VALUES($1,$2,$3)",
                            version.version_id,
                            index,
                            observation_id,
                        )
        if result == "INSERT 0 0":
            existing = await self.get_version(version.version_id)
            if existing != version:
                raise ValueError("map versions are immutable")

    async def get_version(self, version_id: str) -> EndpointMapVersion | None:
        row = await self._pool.fetchrow(
            "SELECT * FROM endpoint_map_versions WHERE version_id=$1", version_id
        )
        return _version_from_row(row) if row else None

    async def get_active(self, site_id: str) -> EndpointMapVersion | None:
        row = await self._pool.fetchrow(
            "SELECT * FROM endpoint_map_versions WHERE site_id=$1 AND approval_state='active'",
            site_id,
        )
        return _version_from_row(row) if row else None

    async def list_active(self) -> tuple[EndpointMapVersion, ...]:
        rows = await self._pool.fetch(
            "SELECT * FROM endpoint_map_versions WHERE approval_state='active' ORDER BY site_id"
        )
        return tuple(_version_from_row(row) for row in rows)

    async def activate(
        self, site_id: str, version_id: str, *, actor: str, reason: str
    ) -> EndpointMapVersion:
        if not actor.strip() or not reason.strip():
            raise ValueError("activation requires actor and reason")
        timestamp = datetime.now(UTC).isoformat()
        async with self._pool.acquire() as connection, connection.transaction():
            row = await connection.fetchrow(
                "SELECT * FROM endpoint_map_versions WHERE version_id=$1 AND site_id=$2 FOR UPDATE",
                version_id,
                site_id,
            )
            if not row:
                raise KeyError("map version not found for site")
            version = _version_from_row(row)
            if version.approval_state is not ApprovalState.PENDING:
                raise ValueError("only pending map versions can be activated")
            if any(operation.stale for operation in version.operations):
                raise ValueError("stale map versions cannot be activated")
            await connection.execute(
                "UPDATE endpoint_map_versions SET approval_state='superseded' "
                "WHERE site_id=$1 AND approval_state='active'",
                site_id,
            )
            await connection.execute(
                "UPDATE endpoint_map_versions SET approval_state='active', activated_at=$1, "
                "activated_by=$2, activation_reason=$3 WHERE version_id=$4",
                timestamp,
                actor,
                reason,
                version_id,
            )
            await connection.execute(
                "INSERT INTO endpoint_map_activations"
                "(site_id,version_id,activated_at,actor,reason) "
                "VALUES($1,$2,$3,$4,$5)",
                site_id,
                version_id,
                timestamp,
                actor,
                reason,
            )
        active = await self.get_version(version_id)
        if active is None:
            raise RuntimeError("activated map disappeared")
        return active

    async def activation_history(self, site_id: str) -> tuple[ActivationRecord, ...]:
        rows = await self._pool.fetch(
            "SELECT site_id,version_id,activated_at,actor,reason FROM endpoint_map_activations "
            "WHERE site_id=$1 ORDER BY activation_id",
            site_id,
        )
        return tuple(
            ActivationRecord(
                str(row["site_id"]),
                str(row["version_id"]),
                str(row["activated_at"]),
                str(row["actor"]),
                str(row["reason"]),
            )
            for row in rows
        )


__all__ = [
    "EndpointMapRepository",
    "InMemoryEndpointMapRepository",
    "PostgresEndpointMapRepository",
]
