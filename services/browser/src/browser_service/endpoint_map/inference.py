"""Deterministic inference of :class:`NormalizedOperation` templates from
sanitized network observations (P03-F02, build steps 2-3).

Path templating (``_cluster_distinct_paths``): observations for a given
(method, origin, segment-count) bucket are first collapsed to their set of
*distinct* literal paths (so an endpoint hit many times with the exact same
path never spuriously "varies"). Candidate variable positions are then
scanned left-to-right: two or more distinct paths that agree on every
position *except* one are merged into a single template with that position
replaced by ``{var}``, and removed from further consideration. Because the
inputs to this scan are already deduplicated distinct paths, any such
agreement is guaranteed to reflect genuine variation, never an accidental
duplicate. This directly implements "a segment that varies across >=2
observations sharing the same method+origin+other-segments becomes a
template variable" while refusing to generalize a position from a single
observation, and refusing to merge two paths that differ in more than one
position at once (e.g. ``/users/123`` vs ``/products/456`` never merge, even
though *some* position differs in each -- they never agree on the others).

Confidence (``_confidence``): a deterministic, order-independent blend of
two signals -- repetition (how many observations corroborate this
operation, saturating at ``_REPETITION_SATURATION`` observations) and shape
consistency (what fraction of those observations agree on the operation's
dominant status/content-type/body-kind signature). Both signals are derived
purely from counts over the observation set, so re-running inference on the
same set (in any order) always yields the same confidence.
"""

from __future__ import annotations

import logging
from collections import Counter, defaultdict
from collections.abc import Sequence
from typing import TypeVar

from browser_service.endpoint_map.models import (
    BodyShapeSchema,
    FieldPresence,
    NormalizedOperation,
    ParameterSchema,
    ResponseSchema,
)
from browser_service.network.observation import BodyShape, SanitizedNetworkObservation

logger = logging.getLogger("browser_service.endpoint_map.inference")

_VARIABLE_SEGMENT = "{var}"
_REPETITION_SATURATION = 5.0

_T = TypeVar("_T")


def _segments(path: str) -> tuple[str, ...]:
    return tuple(part for part in path.split("/") if part != "")


def _join_template(segments: Sequence[str]) -> str:
    return "/" + "/".join(segments) if segments else "/"


class _TemplateGroup:
    __slots__ = ("path_template", "observation_ids")

    def __init__(self, path_template: str, observation_ids: tuple[str, ...]) -> None:
        self.path_template = path_template
        self.observation_ids = observation_ids


def _cluster_distinct_paths(
    distinct_paths: dict[tuple[str, ...], list[str]], length: int
) -> list[_TemplateGroup]:
    remaining: dict[tuple[str, ...], list[str]] = dict(distinct_paths)
    groups: list[_TemplateGroup] = []

    for position in range(length):
        buckets: dict[tuple[str, ...], list[tuple[str, ...]]] = defaultdict(list)
        for segments in remaining:
            key = segments[:position] + segments[position + 1 :]
            buckets[key].append(segments)

        for members in buckets.values():
            if len(members) < 2:
                continue
            template = list(members[0])
            template[position] = _VARIABLE_SEGMENT
            observation_ids: list[str] = []
            for segments in members:
                observation_ids.extend(remaining.pop(segments))
            groups.append(
                _TemplateGroup(
                    path_template=_join_template(template),
                    observation_ids=tuple(sorted(observation_ids)),
                )
            )

    for segments, observation_ids in remaining.items():
        groups.append(
            _TemplateGroup(
                path_template=_join_template(list(segments)),
                observation_ids=tuple(sorted(observation_ids)),
            )
        )
    return groups


def _templates_for_method_origin(
    paths: list[tuple[tuple[str, ...], str]],
) -> list[_TemplateGroup]:
    by_length: dict[int, dict[tuple[str, ...], list[str]]] = defaultdict(lambda: defaultdict(list))
    for segments, observation_id in paths:
        by_length[len(segments)][segments].append(observation_id)

    groups: list[_TemplateGroup] = []
    for length, distinct_paths in sorted(by_length.items()):
        groups.extend(_cluster_distinct_paths(distinct_paths, length))
    return groups


def _mode(counts: Counter[_T]) -> _T:
    """Deterministically pick the highest-count key, breaking ties on the
    key's string form so the result never depends on dict/set iteration
    order (which in turn could otherwise depend on input observation
    order)."""
    return min(counts.items(), key=lambda item: (-item[1], str(item[0])))[0]


def _field_presence(names_per_observation: list[frozenset[str]]) -> tuple[FieldPresence, ...]:
    total = len(names_per_observation)
    counts: Counter[str] = Counter()
    for names in names_per_observation:
        counts.update(names)
    return tuple(
        FieldPresence(name=name, optional=count < total) for name, count in sorted(counts.items())
    )


def _body_shape(shapes: list[BodyShape | None]) -> BodyShapeSchema:
    present = [shape for shape in shapes if shape is not None]
    if not present:
        return BodyShapeSchema(kind=None)

    kind_counts: Counter[str] = Counter(shape.kind for shape in present)
    kind = _mode(kind_counts)

    object_shapes = [shape for shape in present if shape.kind == "object"]
    key_counts: Counter[str] = Counter()
    for shape in object_shapes:
        key_counts.update(shape.keys)
    object_total = len(object_shapes)
    keys = tuple(
        FieldPresence(name=name, optional=count < object_total)
        for name, count in sorted(key_counts.items())
    )
    return BodyShapeSchema(kind=kind, keys=keys)


def _infer_parameter_schema(observations: list[SanitizedNetworkObservation]) -> ParameterSchema:
    query_parameters = _field_presence([frozenset(obs.query_keys) for obs in observations])
    request_body = _body_shape([obs.request_body_shape for obs in observations])
    return ParameterSchema(query_parameters=query_parameters, request_body=request_body)


def _infer_response_schema(observations: list[SanitizedNetworkObservation]) -> ResponseSchema:
    status_codes = tuple(sorted({obs.status for obs in observations if obs.status is not None}))
    content_types = tuple(
        sorted({obs.content_type for obs in observations if obs.content_type})
    )
    body = _body_shape([obs.response_body_shape for obs in observations])
    stable_headers = _field_presence(
        [frozenset(obs.stable_response_headers) for obs in observations]
    )
    return ResponseSchema(
        status_codes=status_codes,
        content_types=content_types,
        body=body,
        stable_headers=stable_headers,
    )


def _confidence(observations: list[SanitizedNetworkObservation]) -> float:
    total = len(observations)
    if total == 0:
        return 0.0

    repetition_component = min(1.0, total / _REPETITION_SATURATION)

    signatures: Counter[tuple[int | None, str | None, str | None, str | None]] = Counter(
        (
            obs.status,
            obs.content_type,
            obs.request_body_shape.kind if obs.request_body_shape is not None else None,
            obs.response_body_shape.kind if obs.response_body_shape is not None else None,
        )
        for obs in observations
    )
    dominant_signature = _mode(signatures)
    consistency_component = signatures[dominant_signature] / total

    return round(0.5 * repetition_component + 0.5 * consistency_component, 4)


def _build_operation(
    method: str,
    origin: str,
    path_template: str,
    group_observations: list[SanitizedNetworkObservation],
) -> NormalizedOperation:
    return NormalizedOperation(
        method=method,
        origin=origin,
        path_template=path_template,
        parameters=_infer_parameter_schema(group_observations),
        response=_infer_response_schema(group_observations),
        confidence=_confidence(group_observations),
        provenance=tuple(sorted(obs.observation_id for obs in group_observations)),
        last_seen=max(obs.captured_at for obs in group_observations),
    )


def infer_operations(
    observations: Sequence[SanitizedNetworkObservation],
) -> tuple[NormalizedOperation, ...]:
    """Infer a deterministic, order-independent tuple of normalized
    operations from ``observations``. Never mutates its input; safe to call
    repeatedly on the same or overlapping observation sets."""
    by_id: dict[str, SanitizedNetworkObservation] = {}
    by_method_origin: dict[tuple[str, str], list[tuple[tuple[str, ...], str]]] = defaultdict(list)
    for obs in observations:
        by_id[obs.observation_id] = obs
        by_method_origin[(obs.method.upper(), obs.origin)].append(
            (_segments(obs.path), obs.observation_id)
        )

    operations: list[NormalizedOperation] = []
    for method_origin in sorted(by_method_origin):
        method, origin = method_origin
        groups = _templates_for_method_origin(by_method_origin[method_origin])
        for group in sorted(groups, key=lambda g: g.path_template):
            group_observations = [by_id[oid] for oid in group.observation_ids]
            operations.append(_build_operation(method, origin, group.path_template, group_observations))

    logger.debug(
        "inferred %d operation(s) from %d observation(s)", len(operations), len(observations)
    )
    return tuple(operations)


__all__ = ["infer_operations"]
