"""`contractVersion` major-version enforcement, mirroring
`packages/contracts/tests/version.test.ts` on the TypeScript side.

Every generated envelope model has `contractVersion: Literal[1]` (see
`browser_service/contracts/generated/*.py`), derived straight from the
`z.literal(CONTRACT_MAJOR_VERSION)` field in
`packages/contracts/src/version.ts`. A payload with a mismatched major
version is therefore rejected by Pydantic on its own -- no wrapper code
needed, verified here.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from browser_service.contracts import CancellationRequest, InvocationSystemEcho

BASE_CORRELATION = {
    "requestId": "req-0001",
    "userId": "user-0001",
    "sessionId": "sess-0001",
    "taskId": "task-0001",
}


def test_accepts_matching_major_version() -> None:
    InvocationSystemEcho.model_validate(
        {
            "contractVersion": 1,
            "correlation": BASE_CORRELATION,
            "toolCallId": "call-0001",
            "toolName": "system.echo",
            "arguments": {"message": "hi"},
        }
    )


def test_rejects_mismatched_major_version() -> None:
    with pytest.raises(ValidationError) as exc_info:
        InvocationSystemEcho.model_validate(
            {
                "contractVersion": 2,
                "correlation": BASE_CORRELATION,
                "toolCallId": "call-0001",
                "toolName": "system.echo",
                "arguments": {"message": "hi"},
            }
        )
    errors = exc_info.value.errors()
    assert any(err["loc"] == ("contractVersion",) for err in errors)


def test_rejects_old_shape_payload_missing_contract_version() -> None:
    with pytest.raises(ValidationError):
        InvocationSystemEcho.model_validate(
            {
                "correlation": BASE_CORRELATION,
                "toolCallId": "call-0001",
                "toolName": "system.echo",
                "arguments": {"message": "hi"},
            }
        )


def test_version_enforcement_applies_to_every_envelope_spot_check_cancellation() -> None:
    with pytest.raises(ValidationError):
        CancellationRequest.model_validate(
            {"contractVersion": 999, "correlation": BASE_CORRELATION}
        )
