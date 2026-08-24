"""Typed tool invocation bridge, generic over every tool in `TOOL_REGISTRY`."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Depends, Request
from pydantic import ValidationError

from browser_service.auth import require_service_token
from browser_service.tool_outcome import ToolExecutionError
from browser_service.tool_registry import TOOL_REGISTRY
from browser_service.tools.invoke_discovered_api import get_discovered_tool_definitions

router = APIRouter(prefix="/v1/tools", dependencies=[Depends(require_service_token)])
logger = logging.getLogger("browser_service.api.bridge")


@router.get("/discovered")
async def discovered_tools() -> dict[str, object]:
    return {"tools": await get_discovered_tool_definitions()}


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

    tool_name = body.get("toolName")
    registration = TOOL_REGISTRY.get(tool_name) if isinstance(tool_name, str) else None
    if registration is None:
        return _error(body, "UNKNOWN_TOOL", "The requested tool is not registered.", False)

    try:
        invocation = registration.invocation_model.model_validate(body)
    except ValidationError:
        return _error(
            body,
            "INVALID_ARGUMENTS",
            "Invocation does not match the tool contract.",
            False,
        )

    cancelled = asyncio.Event()
    task = asyncio.create_task(registration.handler(invocation, cancelled))
    disconnect_watch = asyncio.create_task(_watch_disconnect(request, cancelled))
    try:
        outcome = await task
    except asyncio.CancelledError:
        return _error(body, "CANCELLED", "Invocation was cancelled.", True)
    except ToolExecutionError as exc:
        return _error(body, exc.code, exc.message, exc.retryable)
    except Exception:
        # Never leak a raw exception message/stack trace across the
        # bridge -- see `redaction.py`'s docstring and this project's
        # "never expose ... raw authenticated page data" rule.
        logger.exception(
            "browser_service.tool_handler_failed", extra={"toolName": invocation.toolName}
        )
        return _error(body, "INTERNAL", "The tool could not complete safely.", False)
    finally:
        disconnect_watch.cancel()

    response: dict[str, Any] = {
        "contractVersion": 1,
        "correlation": invocation.correlation.model_dump(exclude_none=True),
        "toolCallId": invocation.toolCallId,
        "status": "success",
        "payload": outcome.payload,
        "sensitivity": {"sensitive": registration.sensitive, "confirmationRequired": False},
    }
    if outcome.evidence:
        response["evidence"] = outcome.evidence

    try:
        registration.success_model.model_validate(response)
    except ValidationError:
        # A handler's payload drifted from its own declared contract --
        # fail safely rather than return a response the caller's own
        # schema would reject anyway.
        logger.error(
            "browser_service.tool_result_contract_violation",
            extra={"toolName": invocation.toolName},
        )
        return _error(body, "INTERNAL", "The tool produced an invalid result.", False)

    return response


async def _watch_disconnect(request: Request, cancelled: asyncio.Event) -> None:
    while not cancelled.is_set():
        if await request.is_disconnected():
            cancelled.set()
            return
        await asyncio.sleep(0.01)
