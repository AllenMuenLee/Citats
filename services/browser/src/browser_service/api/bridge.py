"""Typed Phase-0 tool invocation bridge."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends, Request
from pydantic import ValidationError

from browser_service.auth import require_service_token
from browser_service.contracts.generated.invocation_system_echo import InvocationSystemEcho
from browser_service.tool_registry import TOOL_REGISTRY

router = APIRouter(prefix="/v1/tools", dependencies=[Depends(require_service_token)])


def _error(body: dict[str, Any], code: str, message: str, retryable: bool) -> dict[str, Any]:
    correlation = body.get("correlation")
    if not isinstance(correlation, dict):
        correlation = {"requestId": "invalid-request", "userId": "invalid-user"}
    tool_call_id = body.get("toolCallId")
    if not isinstance(tool_call_id, str):
        tool_call_id = "invalid-tool-call"
    return {
        "contractVersion": 1,
        "correlation": correlation,
        "toolCallId": tool_call_id,
        "status": "error",
        "errorCode": code,
        "message": message,
        "retryable": retryable,
    }


@router.post("/invoke")
async def invoke_tool(request: Request) -> dict[str, Any]:
    """Validate and dispatch only registered, version-1 tool invocations."""
    try:
        body = await request.json()
    except ValueError:
        return _error({}, "INVALID_ARGUMENTS", "Invocation body must be valid JSON.", False)
    if not isinstance(body, dict):
        return _error({}, "INVALID_ARGUMENTS", "Invocation body must be an object.", False)
    if body.get("toolName") not in TOOL_REGISTRY:
        return _error(body, "UNKNOWN_TOOL", "The requested tool is not registered.", False)
    try:
        invocation = InvocationSystemEcho.model_validate(body)
    except ValidationError:
        return _error(
            body,
            "INVALID_ARGUMENTS",
            "Invocation does not match the tool contract.",
            False,
        )

    cancelled = asyncio.Event()
    task = asyncio.create_task(TOOL_REGISTRY[invocation.toolName](invocation, cancelled))
    disconnect_watch = asyncio.create_task(_watch_disconnect(request, cancelled))
    try:
        message = await task
    except asyncio.CancelledError:
        return _error(body, "CANCELLED", "Invocation was cancelled.", True)
    finally:
        disconnect_watch.cancel()
    return {
        "contractVersion": 1,
        "correlation": invocation.correlation.model_dump(exclude_none=True),
        "toolCallId": invocation.toolCallId,
        "status": "success",
        "payload": {"message": message},
        "sensitivity": {"sensitive": False, "confirmationRequired": False},
    }


async def _watch_disconnect(request: Request, cancelled: asyncio.Event) -> None:
    while not cancelled.is_set():
        if await request.is_disconnected():
            cancelled.set()
            return
        await asyncio.sleep(0.01)
