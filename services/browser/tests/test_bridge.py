from __future__ import annotations

import asyncio
import os
from typing import Any

from fastapi.testclient import TestClient

from browser_service.app import app
from browser_service.contracts import InvocationSystemEcho
from browser_service.redaction import REDACTED, redact
from browser_service.tool_registry import system_echo

TOKEN = "test-launch-token"


def invocation(**overrides: Any) -> dict[str, Any]:
    value: dict[str, Any] = {
        "contractVersion": 1,
        "correlation": {"requestId": "req-bridge-1", "userId": "user-1"},
        "toolCallId": "call-1",
        "toolName": "system.echo",
        "arguments": {"message": "hello"},
    }
    value.update(overrides)
    return value


def client() -> TestClient:
    os.environ["BROWSER_SERVICE_TOKEN"] = TOKEN
    return TestClient(app)


def test_echo_success_and_authentication() -> None:
    with client() as test_client:
        assert test_client.post("/v1/tools/invoke", json=invocation()).status_code == 401
        response = test_client.post(
            "/v1/tools/invoke",
            json=invocation(),
            headers={"X-Service-Token": TOKEN, "X-Request-Id": "req-bridge-1"},
        )
    assert response.status_code == 200
    assert response.headers["X-Request-Id"] == "req-bridge-1"
    assert response.json()["payload"] == {"message": "hello"}
    assert response.json()["correlation"]["requestId"] == "req-bridge-1"


def test_invalid_and_unknown_invocations_are_normalized() -> None:
    with client() as test_client:
        invalid = test_client.post(
            "/v1/tools/invoke",
            json=invocation(arguments={"message": "hello", "cookie": "nope"}),
            headers={"X-Service-Token": TOKEN},
        )
        unknown = test_client.post(
            "/v1/tools/invoke",
            json=invocation(toolName="browser.secret"),
            headers={"X-Service-Token": TOKEN},
        )
    assert invalid.json()["errorCode"] == "INVALID_ARGUMENTS"
    assert unknown.json()["errorCode"] == "UNKNOWN_TOOL"


def test_echo_delay_is_bounded_and_observes_cancellation() -> None:
    value = invocation(arguments={"message": "hello", "context": {"delayMs": 50_000}})
    model = InvocationSystemEcho.model_validate(value)

    async def run() -> None:
        cancelled = asyncio.Event()
        cancelled.set()
        try:
            await system_echo(model, cancelled)
        except asyncio.CancelledError:
            return
        raise AssertionError("expected cancellation")

    asyncio.run(run())


def test_recursive_log_redaction() -> None:
    assert redact({"nested": {"authorization": "Bearer secret"}, "token": "secret"}) == {
        "nested": {"authorization": REDACTED},
        "token": REDACTED,
    }
