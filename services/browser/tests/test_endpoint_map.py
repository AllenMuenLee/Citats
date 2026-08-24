from __future__ import annotations

from dataclasses import replace

import pytest

from browser_service.endpoint_map.inference import infer_operations
from browser_service.endpoint_map.models import (
    ApprovalState,
    BodyShapeSchema,
    DriftKind,
    FieldPresence,
    NormalizedOperation,
    ParameterSchema,
    ResponseSchema,
    Site,
)
from browser_service.endpoint_map.repository import InMemoryEndpointMapRepository
from browser_service.endpoint_map.snapshots import compare_with_active, create_snapshot
from browser_service.network.observation import (
    BodyShape,
    InitiatorCategory,
    SanitizedNetworkObservation,
)


def observation(
    observation_id: str,
    path: str,
    *,
    query_keys: tuple[str, ...] = (),
    status: int = 200,
    content_type: str = "application/json",
    response_keys: tuple[str, ...] = ("items",),
) -> SanitizedNetworkObservation:
    return SanitizedNetworkObservation(
        observation_id=observation_id,
        task_id="task",
        session_id="session",
        captured_at=f"2026-01-{int(observation_id.removeprefix('o')):02d}T00:00:00+00:00",
        method="get",
        origin="HTTPS://API.EXAMPLE.TEST:443",
        path=path,
        query_keys=query_keys,
        same_origin=True,
        status=status,
        content_type=content_type,
        timing_ms=1.0,
        initiator=InitiatorCategory.SCRIPT,
        request_body_shape=None,
        response_body_shape=BodyShape("object", response_keys),
        stable_response_headers=("etag",),
        redacted=True,
        truncated=False,
    )


def test_inference_is_deterministic_and_generalizes_one_repeated_segment() -> None:
    observations = [
        observation("o1", "/products/100", query_keys=("currency", "page")),
        observation("o2", "/products/200", query_keys=("currency",)),
        observation("o3", "/products/300", query_keys=("currency", "page")),
    ]
    forward = infer_operations(observations)
    reverse = infer_operations(list(reversed(observations)))
    assert forward == reverse
    assert len(forward) == 1
    operation = forward[0]
    assert operation.origin == "https://api.example.test"
    assert operation.path_template == "/products/{var}"
    assert operation.provenance == ("o1", "o2", "o3")
    assert operation.parameters.query_parameters == (
        FieldPresence("currency", False),
        FieldPresence("page", True),
    )


def test_inference_refuses_false_merge_and_single_observation_generalization() -> None:
    operations = infer_operations(
        [
            observation("o1", "/users/100"),
            observation("o2", "/products/200"),
            observation("o3", "/orders/static"),
        ]
    )
    assert [operation.path_template for operation in operations] == [
        "/orders/static",
        "/products/200",
        "/users/100",
    ]


def test_path_normalization_is_stable() -> None:
    operations = infer_operations(
        [observation("o1", "/v1/./products/%31"), observation("o2", "/v1/x/../products/2")]
    )
    assert operations[0].path_template == "/v1/products/{var}"


def test_duplicate_observation_ids_are_rejected() -> None:
    with pytest.raises(ValueError, match="unique"):
        infer_operations([observation("o1", "/a"), observation("o1", "/b")])


def test_optional_response_keys_and_confidence_are_bounded() -> None:
    operation = infer_operations(
        [
            observation("o1", "/search", response_keys=("items", "next")),
            observation("o2", "/search", response_keys=("items",)),
        ]
    )[0]
    assert operation.response.body.keys == (
        FieldPresence("items", False),
        FieldPresence("next", True),
    )
    assert 0 <= operation.confidence <= 1


def _operation() -> NormalizedOperation:
    return NormalizedOperation(
        method="GET",
        origin="https://api.example.test",
        path_template="/products/{var}",
        parameters=ParameterSchema(
            query_parameters=(FieldPresence("currency", False),),
            request_body=BodyShapeSchema(None),
        ),
        response=ResponseSchema(
            status_codes=(200,),
            content_types=("application/json",),
            body=BodyShapeSchema("object", (FieldPresence("items", False),)),
            stable_headers=(FieldPresence("etag", False),),
        ),
        confidence=0.9,
        provenance=("observation-1",),
        last_seen="2026-01-01T00:00:00+00:00",
    )


def test_snapshot_id_is_content_deterministic_and_created_at_independent() -> None:
    operation = _operation()
    first = create_snapshot("fixture", (operation,), created_at="2026-01-01T00:00:00Z")
    second = create_snapshot("fixture", (operation,), created_at="2026-02-01T00:00:00Z")
    assert first.version_id == second.version_id
    assert first.approval_state is ApprovalState.PENDING


def test_drift_marks_changed_operation_stale_and_reports_removed_operation() -> None:
    old = _operation()
    removed = replace(old, path_template="/removed")
    active = replace(
        create_snapshot("fixture", (old, removed), created_at="2026-01-01T00:00:00Z"),
        approval_state=ApprovalState.ACTIVE,
        activated_at="2026-01-02T00:00:00Z",
        activated_by="reviewer",
        activation_reason="manual review",
    )
    changed_response = replace(
        old.response,
        status_codes=(200, 206),
        body=BodyShapeSchema("array"),
    )
    candidate = create_snapshot(
        "fixture", (replace(old, response=changed_response),), created_at="2026-02-01T00:00:00Z"
    )
    compared, alerts = compare_with_active(candidate, active)
    assert compared.operations[0].stale is True
    alerts_by_key = {alert.operation_key: alert.kinds for alert in alerts}
    assert alerts_by_key[removed.operation_key] == (DriftKind.REMOVED,)
    assert alerts_by_key[old.operation_key] == (
        DriftKind.STATUS_CHANGED,
        DriftKind.RESPONSE_INCOMPATIBLE,
    )


@pytest.mark.asyncio
async def test_repository_requires_explicit_audited_activation_and_supersedes() -> None:
    repository = InMemoryEndpointMapRepository()
    await repository.save_site(Site("fixture", "https://api.example.test", "2026-01-01T00:00:00Z"))
    first = create_snapshot("fixture", (_operation(),), created_at="2026-01-01T00:00:00Z")
    second = create_snapshot(
        "fixture",
        (replace(_operation(), provenance=("observation-2",)),),
        created_at="2026-02-01T00:00:00Z",
    )
    await repository.save_version(first)
    await repository.save_version(second)
    assert await repository.get_active("fixture") is None
    await repository.activate("fixture", first.version_id, actor="reviewer", reason="reviewed")
    activated = await repository.activate(
        "fixture", second.version_id, actor="reviewer", reason="new observations"
    )
    assert activated.is_active
    superseded = await repository.get_version(first.version_id)
    assert superseded is not None
    assert superseded.approval_state is ApprovalState.SUPERSEDED
    assert len(await repository.activation_history("fixture")) == 2


@pytest.mark.asyncio
async def test_repository_rejects_mutation_and_stale_activation() -> None:
    repository = InMemoryEndpointMapRepository()
    await repository.save_site(Site("fixture", "https://api.example.test", "2026-01-01T00:00:00Z"))
    version = create_snapshot("fixture", (_operation(),), created_at="2026-01-01T00:00:00Z")
    await repository.save_version(version)
    with pytest.raises(ValueError, match="immutable"):
        await repository.save_version(replace(version, created_at="2027-01-01T00:00:00Z"))
    stale = create_snapshot(
        "fixture",
        (replace(_operation(), stale=True, stale_reason="response_incompatible"),),
        created_at="2026-02-01T00:00:00Z",
    )
    await repository.save_version(stale)
    with pytest.raises(ValueError, match="stale"):
        await repository.activate("fixture", stale.version_id, actor="reviewer", reason="no")


def test_domain_models_reject_value_bearing_or_invalid_storage_shapes() -> None:
    with pytest.raises(ValueError):
        replace(_operation(), method="get")
    with pytest.raises(ValueError):
        replace(_operation(), confidence=1.1)
    with pytest.raises(ValueError):
        replace(_operation(), provenance=("z", "a"))
