"""Public Pydantic contract models for the browser service.

Per ADR 0004
(`docs/architecture/decisions/0004-canonical-schema-ownership.md`),
`packages/contracts/src/` (TypeScript/Zod) is the single source of truth.
The models under `browser_service.contracts.generated` are generated 1:1
from the committed JSON Schema artifacts at
`packages/contracts/schema/*.schema.json` (see
`scripts/generate_contracts.py`) and are never hand-edited.

This module is the thin wrapper layer ADR 0004 calls for: it re-exports
the generated models under stable public names and adds the handful of
validation rules that JSON Schema cannot express structurally, so a
payload rejected by the TypeScript side (`packages/contracts/src/`) is
rejected here too:

  - the recursive credential-shaped-field rejection
    (`_validators.assert_no_forbidden_fields`, mirroring
    `packages/contracts/src/security/credential-guard.ts`), applied to
    every open/tool-defined payload (invocation arguments, success-result
    payload, progress-event partial payload);
  - the `http`/`https`-only URL scheme check on evidence `sourceUrl`
    (`_validators.is_http_or_https_url`, mirroring `HttpUrlSchema` in
    `packages/contracts/src/primitives.ts`);
  - the cancellation cross-field rule that `correlation.taskId` must be
    present (mirroring the `.superRefine` in
    `packages/contracts/src/cancellation.ts`).

`contractVersion` major-version enforcement needs no wrapper code: it is
already a `Literal[1]` field on every generated envelope model, so
Pydantic rejects a mismatched value on its own (see
`tests/test_contracts_version.py`).
"""

from __future__ import annotations

from pydantic import field_validator, model_validator

from browser_service.contracts._validators import (
    ForbiddenCredentialFieldError,
    ForbiddenFieldMatch,
    assert_no_forbidden_fields,
    is_http_or_https_url,
)
from browser_service.contracts.generated.cancellation_request import (
    CancellationRequest as _GeneratedCancellationRequest,
)
from browser_service.contracts.generated.cancellation_result import (
    CancellationResult as _GeneratedCancellationResult,
)
from browser_service.contracts.generated.correlation_metadata import (
    CorrelationMetadata,
)
from browser_service.contracts.generated.compiled_generated_ui_artifact import CompiledGeneratedUiArtifact
from browser_service.contracts.generated.error_result import ErrorResult
from browser_service.contracts.generated.evidence_item import (
    EvidenceItem as _GeneratedEvidenceItem,
)
from browser_service.contracts.generated.invocation_explore_website import (
    InvocationExploreWebsite as _GeneratedInvocationExploreWebsite,
)
from browser_service.contracts.generated.invocation_get_page_understanding_slice import (
    InvocationGetPageUnderstandingSlice as _GeneratedInvocationGetPageUnderstandingSlice,
)
from browser_service.contracts.generated.invocation_navigate_and_extract import (
    InvocationNavigateAndExtract as _GeneratedInvocationNavigateAndExtract,
)
from browser_service.contracts.generated.invocation_propose_generative_ui_plan import (
    InvocationProposeGenerativeUiPlan as _GeneratedInvocationProposeGenerativeUiPlan,
)
from browser_service.contracts.generated.invocation_system_echo import (
    InvocationSystemEcho as _GeneratedInvocationSystemEcho,
)
from browser_service.contracts.generated.progress_event_system_echo import (
    ProgressEventSystemEcho as _GeneratedProgressEventSystemEcho,
)
from browser_service.contracts.generated.sensitivity import Sensitivity
from browser_service.contracts.generated.success_result_explore_website import (
    SuccessResultExploreWebsite as _GeneratedSuccessResultExploreWebsite,
)
from browser_service.contracts.generated.success_result_get_page_understanding_slice import (
    SuccessResultGetPageUnderstandingSlice as _GeneratedSuccessResultGetPageUnderstandingSlice,
)
from browser_service.contracts.generated.success_result_navigate_and_extract import (
    SuccessResultNavigateAndExtract as _GeneratedSuccessResultNavigateAndExtract,
)
from browser_service.contracts.generated.success_result_propose_generative_ui_plan import (
    SuccessResultProposeGenerativeUiPlan as _GeneratedSuccessResultProposeGenerativeUiPlan,
)
from browser_service.contracts.generated.success_result_system_echo import (
    SuccessResultSystemEcho as _GeneratedSuccessResultSystemEcho,
)
from browser_service.contracts.generated.tool_definition import ToolDefinition
from browser_service.contracts.generated.ui_generation_request import UiGenerationRequest
from browser_service.contracts.generated.ui_generation_response import UiGenerationResponse as _GeneratedUiGenerationResponse

__all__ = [
    "ForbiddenCredentialFieldError",
    "ForbiddenFieldMatch",
    "ToolDefinition",
    "CorrelationMetadata",
    "Sensitivity",
    "EvidenceItem",
    "ErrorResult",
    "InvocationSystemEcho",
    "SuccessResultSystemEcho",
    "ProgressEventSystemEcho",
    "CancellationRequest",
    "CancellationResult",
    "InvocationNavigateAndExtract",
    "SuccessResultNavigateAndExtract",
    "InvocationExploreWebsite",
    "SuccessResultExploreWebsite",
    "InvocationGetPageUnderstandingSlice",
    "SuccessResultGetPageUnderstandingSlice",
    "InvocationProposeGenerativeUiPlan",
    "SuccessResultProposeGenerativeUiPlan",
    "UiGenerationRequest",
    "UiGenerationResponse",
    "CompiledGeneratedUiArtifact",
]


class EvidenceItem(_GeneratedEvidenceItem):
    """`sourceUrl` must be `http`/`https` -- mirrors `HttpUrlSchema`."""

    @field_validator("sourceUrl")
    @classmethod
    def _check_scheme(cls, value: str) -> str:
        if not is_http_or_https_url(value):
            raise ValueError("sourceUrl scheme must be 'http' or 'https'")
        return value


class UiGenerationResponse(_GeneratedUiGenerationResponse):
    @model_validator(mode="after")
    def _require_consistent_fallback(self) -> UiGenerationResponse:
        is_fallback = self.fallbackReason is not None
        if (self.tsxSource is None) != is_fallback or self.manifest.fallback != is_fallback:
            raise ValueError("fallback response must omit source and mark its manifest")
        return self


class InvocationSystemEcho(_GeneratedInvocationSystemEcho):
    """Rejects credential-shaped field names anywhere in `arguments`."""

    @model_validator(mode="after")
    def _check_arguments_for_forbidden_fields(self) -> InvocationSystemEcho:
        assert_no_forbidden_fields(self.arguments.model_dump(), base_path="arguments")
        return self


class SuccessResultSystemEcho(_GeneratedSuccessResultSystemEcho):
    """Rejects credential-shaped field names in `payload`; enforces the
    `http`/`https` URL scheme on every `evidence[].sourceUrl`."""

    @model_validator(mode="after")
    def _check_payload_for_forbidden_fields(self) -> SuccessResultSystemEcho:
        assert_no_forbidden_fields(self.payload.model_dump(), base_path="payload")
        return self

    @field_validator("evidence")
    @classmethod
    def _check_evidence_urls(cls, value: list[object] | None) -> list[object] | None:
        if value is None:
            return value
        for index, item in enumerate(value):
            source_url = getattr(item, "sourceUrl", None)
            if isinstance(source_url, str) and not is_http_or_https_url(source_url):
                raise ValueError(f"evidence[{index}].sourceUrl scheme must be 'http' or 'https'")
        return value


class ProgressEventSystemEcho(_GeneratedProgressEventSystemEcho):
    """Rejects credential-shaped field names in `partialPayload`, when present."""

    @model_validator(mode="after")
    def _check_partial_payload_for_forbidden_fields(self) -> ProgressEventSystemEcho:
        if self.partialPayload is not None:
            assert_no_forbidden_fields(self.partialPayload.model_dump(), base_path="partialPayload")
        return self


class CancellationRequest(_GeneratedCancellationRequest):
    """`correlation.taskId` is required for a cancellation request."""

    @model_validator(mode="after")
    def _require_task_id(self) -> CancellationRequest:
        if not self.correlation.taskId:
            raise ValueError("correlation.taskId is required for a cancellation request")
        return self


class CancellationResult(_GeneratedCancellationResult):
    """`correlation.taskId` is required for a cancellation result."""

    @model_validator(mode="after")
    def _require_task_id(self) -> CancellationResult:
        if not self.correlation.taskId:
            raise ValueError("correlation.taskId is required for a cancellation result")
        return self


class InvocationNavigateAndExtract(_GeneratedInvocationNavigateAndExtract):
    """Rejects credential-shaped field names in `arguments`; enforces the
    `http`/`https` URL scheme on `arguments.url`."""

    @model_validator(mode="after")
    def _check_arguments_for_forbidden_fields(self) -> InvocationNavigateAndExtract:
        assert_no_forbidden_fields(self.arguments.model_dump(), base_path="arguments")
        return self

    @field_validator("arguments")
    @classmethod
    def _check_url_scheme(cls, value: object) -> object:
        url = getattr(value, "url", None)
        if isinstance(url, str) and not is_http_or_https_url(url):
            raise ValueError("arguments.url scheme must be 'http' or 'https'")
        return value


class SuccessResultNavigateAndExtract(_GeneratedSuccessResultNavigateAndExtract):
    """Rejects credential-shaped field names in `payload`; enforces the
    `http`/`https` URL scheme on `payload.metadata.url` and every
    `evidence[].sourceUrl`."""

    @model_validator(mode="after")
    def _check_payload_for_forbidden_fields(self) -> SuccessResultNavigateAndExtract:
        assert_no_forbidden_fields(self.payload.model_dump(), base_path="payload")
        return self

    @field_validator("payload")
    @classmethod
    def _check_metadata_url_scheme(cls, value: object) -> object:
        metadata = getattr(value, "metadata", None)
        url = getattr(metadata, "url", None)
        if isinstance(url, str) and not is_http_or_https_url(url):
            raise ValueError("payload.metadata.url scheme must be 'http' or 'https'")
        return value

    @field_validator("evidence")
    @classmethod
    def _check_evidence_urls(cls, value: list[object] | None) -> list[object] | None:
        if value is None:
            return value
        for index, item in enumerate(value):
            source_url = getattr(item, "sourceUrl", None)
            if isinstance(source_url, str) and not is_http_or_https_url(source_url):
                raise ValueError(f"evidence[{index}].sourceUrl scheme must be 'http' or 'https'")
        return value


class InvocationExploreWebsite(_GeneratedInvocationExploreWebsite):
    """Rejects credential-shaped field names in `arguments`; enforces the
    `http`/`https` URL scheme on `arguments.url`."""

    @model_validator(mode="after")
    def _check_arguments_for_forbidden_fields(self) -> InvocationExploreWebsite:
        assert_no_forbidden_fields(self.arguments.model_dump(), base_path="arguments")
        return self

    @field_validator("arguments")
    @classmethod
    def _check_url_scheme(cls, value: object) -> object:
        url = getattr(value, "url", None)
        if isinstance(url, str) and not is_http_or_https_url(url):
            raise ValueError("arguments.url scheme must be 'http' or 'https'")
        return value


class SuccessResultExploreWebsite(_GeneratedSuccessResultExploreWebsite):
    """Rejects credential-shaped field names in `payload`; enforces the
    `http`/`https` URL scheme on `payload.document.metadata.url` and every
    `evidence[].sourceUrl`."""

    @model_validator(mode="after")
    def _check_payload_for_forbidden_fields(self) -> SuccessResultExploreWebsite:
        assert_no_forbidden_fields(self.payload.model_dump(), base_path="payload")
        return self

    @field_validator("payload")
    @classmethod
    def _check_document_metadata_url_scheme(cls, value: object) -> object:
        document = getattr(value, "document", None)
        metadata = getattr(document, "metadata", None)
        url = getattr(metadata, "url", None)
        if isinstance(url, str) and not is_http_or_https_url(url):
            raise ValueError("payload.document.metadata.url scheme must be 'http' or 'https'")
        return value

    @field_validator("evidence")
    @classmethod
    def _check_evidence_urls(cls, value: list[object] | None) -> list[object] | None:
        if value is None:
            return value
        for index, item in enumerate(value):
            source_url = getattr(item, "sourceUrl", None)
            if isinstance(source_url, str) and not is_http_or_https_url(source_url):
                raise ValueError(f"evidence[{index}].sourceUrl scheme must be 'http' or 'https'")
        return value


class InvocationGetPageUnderstandingSlice(_GeneratedInvocationGetPageUnderstandingSlice):
    """Rejects credential-shaped field names in `arguments`."""

    @model_validator(mode="after")
    def _check_arguments_for_forbidden_fields(self) -> InvocationGetPageUnderstandingSlice:
        assert_no_forbidden_fields(self.arguments.model_dump(), base_path="arguments")
        return self


class SuccessResultGetPageUnderstandingSlice(_GeneratedSuccessResultGetPageUnderstandingSlice):
    """Rejects credential-shaped field names in `payload`."""

    @model_validator(mode="after")
    def _check_payload_for_forbidden_fields(self) -> SuccessResultGetPageUnderstandingSlice:
        assert_no_forbidden_fields(self.payload.model_dump(), base_path="payload")
        return self


class InvocationProposeGenerativeUiPlan(_GeneratedInvocationProposeGenerativeUiPlan):
    """Rejects credential-shaped field names in `arguments`."""

    @model_validator(mode="after")
    def _check_arguments_for_forbidden_fields(self) -> InvocationProposeGenerativeUiPlan:
        assert_no_forbidden_fields(self.arguments.model_dump(), base_path="arguments")
        return self


class SuccessResultProposeGenerativeUiPlan(_GeneratedSuccessResultProposeGenerativeUiPlan):
    """Rejects credential-shaped field names in `payload`."""

    @model_validator(mode="after")
    def _check_payload_for_forbidden_fields(self) -> SuccessResultProposeGenerativeUiPlan:
        assert_no_forbidden_fields(self.payload.model_dump(), base_path="payload")
        return self
