"""Validates every fixture under `packages/contracts/fixtures/` against the
matching Pydantic model in `browser_service.contracts`.

This is the Python half of the "neither runtime can drift independently"
guarantee: `packages/contracts/tests/fixtures.test.ts` walks the exact
same fixture directory tree on the TypeScript/Vitest side, against the
exact same JSON files. Do not duplicate fixture content here -- always
read straight from `packages/contracts/fixtures/`.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

from browser_service.contracts import (
    CancellationRequest,
    CancellationResult,
    CorrelationMetadata,
    ErrorResult,
    EvidenceItem,
    InvocationNavigateAndExtract,
    InvocationSystemEcho,
    ProgressEventSystemEcho,
    Sensitivity,
    SuccessResultNavigateAndExtract,
    SuccessResultSystemEcho,
    ToolDefinition,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES_ROOT = REPO_ROOT / "packages" / "contracts" / "fixtures"

FIXTURE_MODEL_REGISTRY: dict[str, type[BaseModel]] = {
    "tool-definition": ToolDefinition,
    "invocation": InvocationSystemEcho,
    "success-result": SuccessResultSystemEcho,
    "error-result": ErrorResult,
    "progress-event": ProgressEventSystemEcho,
    "cancellation-request": CancellationRequest,
    "cancellation-result": CancellationResult,
    "evidence": EvidenceItem,
    "sensitivity": Sensitivity,
    "correlation-metadata": CorrelationMetadata,
    "invocation-navigate-and-extract": InvocationNavigateAndExtract,
    "success-result-navigate-and-extract": SuccessResultNavigateAndExtract,
}


def _fixture_dirs() -> list[str]:
    assert FIXTURES_ROOT.is_dir(), f"fixtures root not found: {FIXTURES_ROOT}"
    return sorted(p.name for p in FIXTURES_ROOT.iterdir() if p.is_dir())


def _fixture_files(dir_name: str, prefix: str) -> list[Path]:
    return sorted((FIXTURES_ROOT / dir_name).glob(f"{prefix}*.json"))


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def test_fixture_directories_match_registered_schema_types() -> None:
    assert _fixture_dirs() == sorted(FIXTURE_MODEL_REGISTRY.keys())


def test_every_schema_type_has_minimum_fixture_coverage() -> None:
    for dir_name in FIXTURE_MODEL_REGISTRY:
        valid = _fixture_files(dir_name, "valid-")
        invalid = _fixture_files(dir_name, "invalid-")
        assert len(valid) >= 1, f"{dir_name} needs at least one valid-*.json fixture"
        assert len(invalid) >= 2, f"{dir_name} needs at least two invalid-*.json fixtures"


def _valid_cases() -> list[tuple[str, Path]]:
    return [
        (dir_name, path)
        for dir_name in FIXTURE_MODEL_REGISTRY
        for path in _fixture_files(dir_name, "valid-")
    ]


def _invalid_cases() -> list[tuple[str, Path]]:
    return [
        (dir_name, path)
        for dir_name in FIXTURE_MODEL_REGISTRY
        for path in _fixture_files(dir_name, "invalid-")
    ]


@pytest.mark.parametrize(
    "dir_name,path", _valid_cases(), ids=lambda v: v.name if isinstance(v, Path) else v
)
def test_valid_fixture_parses(dir_name: str, path: Path) -> None:
    model = FIXTURE_MODEL_REGISTRY[dir_name]
    data = _load(path)
    try:
        instance = model.model_validate(data)
    except ValidationError as exc:  # pragma: no cover - failure path, asserted below
        pytest.fail(f"expected {dir_name}/{path.name} to be VALID but it was rejected:\n{exc}")
    assert instance is not None


@pytest.mark.parametrize(
    "dir_name,path", _invalid_cases(), ids=lambda v: v.name if isinstance(v, Path) else v
)
def test_invalid_fixture_is_rejected(dir_name: str, path: Path) -> None:
    model = FIXTURE_MODEL_REGISTRY[dir_name]
    data = _load(path)
    with pytest.raises(ValidationError) as exc_info:
        model.model_validate(data)
    # Not just "didn't crash" -- assert there is at least one concrete
    # validation error explaining the rejection.
    assert len(exc_info.value.errors()) > 0
