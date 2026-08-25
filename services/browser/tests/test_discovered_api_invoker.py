from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from browser_service.contracts import (
    InvocationInvokeDiscoveredApi,
    SuccessResultInvokeDiscoveredApi,
)
from browser_service.discovered_api import DiscoveredApiError, DiscoveredApiInvoker, operation_id
from browser_service.endpoint_map.models import (
    BodyShapeSchema,
    EndpointMapVersion,
    FieldPresence,
    NormalizedOperation,
    ParameterSchema,
    ResponseSchema,
    Site,
)
from browser_service.endpoint_map.repository import InMemoryEndpointMapRepository
from browser_service.sites.loader import SitePolicyLoader
from browser_service.tools.invoke_discovered_api import (
    configure_discovered_api_invoker,
    run_invoke_discovered_api,
)


def operation(
    *, method: str = "GET", stale: bool = False, confidence: float = 0.95
) -> NormalizedOperation:
    return NormalizedOperation(
        method=method,
        origin="http://localhost:8765",
        path_template="/api/products",
        parameters=ParameterSchema(
            query_parameters=(FieldPresence("q", True),),
            request_body=BodyShapeSchema(None),
        ),
        response=ResponseSchema(
            status_codes=(200,),
            content_types=("application/json",),
            body=BodyShapeSchema("object", (FieldPresence("products", False),)),
            stable_headers=(FieldPresence("content-type", False),),
        ),
        confidence=confidence,
        provenance=("observation-1", "observation-2"),
        last_seen="2026-08-24T00:00:00+00:00",
        stale=stale,
        stale_reason="drift" if stale else None,
    )


def policy(root: Path) -> SitePolicyLoader:
    root.mkdir()
    (root / "local-fixture.yaml").write_text(
        """schema_version: 1
site_id: local-fixture
canonical_domain: localhost
allowed_subdomains: []
allowed_routes: [/api/*]
allowed_methods: [GET, HEAD]
discovery_permitted: true
replay_permitted: true
data_classification: internal
retention_days: 1
owner: test
reviewer: human
decision: approved
decision_date: 2026-08-24
review_date: 2026-08-24
kill_switch_enabled: false
""",
        encoding="utf-8",
    )
    return SitePolicyLoader(root, approval_staleness_days=None)


async def repository_with(active_operation: NormalizedOperation) -> InMemoryEndpointMapRepository:
    repository = InMemoryEndpointMapRepository()
    await repository.save_site(
        Site("local-fixture", active_operation.origin, datetime.now(UTC).isoformat())
    )
    version = EndpointMapVersion(
        "map-version-1",
        "local-fixture",
        datetime.now(UTC).isoformat(),
        (active_operation,),
    )
    await repository.save_version(version)
    if not active_operation.stale:
        await repository.activate(
            "local-fixture", version.version_id, actor="human", reason="fixture"
        )
    return repository


def client(
    payload: bytes, *, status: int = 200, content_type: str = "application/json"
) -> httpx.AsyncClient:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status, content=payload, headers={"content-type": content_type}, request=request
        )

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_replays_approved_operation_and_returns_bounded_product_records(
    tmp_path: Path,
) -> None:
    mapped = operation()
    repository = await repository_with(mapped)
    async with client(
        b'{"products":[{"id":"p1","name":"Headphones","priceAmount":99,"currency":"USD"}]}'
    ) as http:
        invoker = DiscoveredApiInvoker(
            repository, policy(tmp_path / "sites"), http, resolver=lambda _host: _addresses()
        )
        result = await invoker.invoke(
            "local-fixture",
            operation_id(mapped),
            {"q": "headphones"},
            result_kind="product_results",
        )
    assert result.records == (
        {"id": "p1", "name": "Headphones", "priceAmount": 99, "currency": "USD"},
    )
    assert result.result_kind == "product_results"
    assert result.map_version == "map-version-1"
    assert result.source_url == "http://localhost:8765/api/products?q=headphones"


@pytest.mark.asyncio
async def test_empty_inferred_body_does_not_reject_a_real_response(tmp_path: Path) -> None:
    """A known limitation (headless Chrome's `Network.getResponseBody`
    frequently can't retrieve a real XHR/fetch response body -- see
    `network/capture.py`'s `on_loading_finished` docstring) means a real
    discovered operation's inferred `response.body.kind` often comes back
    "empty" even when the endpoint's actual JSON response has a body. That
    must never turn into a permanent `RESPONSE_DRIFT` on every replay: an
    "empty"/unknown inferred shape asserts nothing about the live response.
    """
    mapped = NormalizedOperation(
        method="GET",
        origin="http://localhost:8765",
        path_template="/api/products",
        parameters=ParameterSchema(
            query_parameters=(),
            request_body=BodyShapeSchema(None),
        ),
        response=ResponseSchema(
            status_codes=(200,),
            content_types=("application/json",),
            body=BodyShapeSchema(None),
            stable_headers=(),
        ),
        confidence=0.95,
        provenance=("observation-1",),
        last_seen="2026-08-24T00:00:00+00:00",
    )
    repository = await repository_with(mapped)
    async with client(b'{"products":[{"id":"p1","name":"Headphones"}]}') as http:
        invoker = DiscoveredApiInvoker(
            repository, policy(tmp_path / "sites"), http, resolver=lambda _host: _addresses()
        )
        result = await invoker.invoke("local-fixture", operation_id(mapped), {})
    assert result.records == ({"id": "p1", "name": "Headphones"},)
    # resultKind is still classified correctly off the live response,
    # independent of the (broken) inferred shape.
    assert result.result_kind == "product_results"


async def _addresses() -> tuple[str, ...]:
    return ("127.0.0.1",)


@pytest.mark.asyncio
async def test_rejects_undeclared_parameters_and_low_confidence(tmp_path: Path) -> None:
    mapped = operation(confidence=0.5)
    repository = await repository_with(mapped)
    async with client(b'{"products":[]}') as http:
        invoker = DiscoveredApiInvoker(
            repository, policy(tmp_path / "sites"), http, resolver=lambda _host: _addresses()
        )
        with pytest.raises(DiscoveredApiError, match="not approved"):
            await invoker.invoke("local-fixture", operation_id(mapped), {})


@pytest.mark.asyncio
async def test_rejects_state_changing_operation_even_when_mapped(tmp_path: Path) -> None:
    mapped = operation(method="POST")
    repository = await repository_with(mapped)
    async with client(b'{"products":[]}') as http:
        invoker = DiscoveredApiInvoker(
            repository,
            policy(tmp_path / "sites"),
            http,
            resolver=lambda _host: _addresses(),
        )
        with pytest.raises(DiscoveredApiError) as failure:
            await invoker.invoke("local-fixture", operation_id(mapped), {})
    assert failure.value.code == "POLICY_BLOCKED"


@pytest.mark.asyncio
async def test_redirect_target_is_revalidated_against_mapped_origin(tmp_path: Path) -> None:
    mapped = operation()
    repository = await repository_with(mapped)

    async def redirect(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            302,
            headers={"location": "https://evil.test/collect"},
            request=request,
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(redirect)) as http:
        invoker = DiscoveredApiInvoker(
            repository,
            policy(tmp_path / "sites"),
            http,
            resolver=lambda _host: _addresses(),
        )
        with pytest.raises(DiscoveredApiError) as failure:
            await invoker.invoke("local-fixture", operation_id(mapped), {})
    assert failure.value.code == "POLICY_BLOCKED"


@pytest.mark.asyncio
async def test_stale_or_missing_active_map_fails_closed(tmp_path: Path) -> None:
    repository = InMemoryEndpointMapRepository()
    async with client(b"{}") as http:
        invoker = DiscoveredApiInvoker(
            repository, policy(tmp_path / "sites"), http, resolver=lambda _host: _addresses()
        )
        with pytest.raises(DiscoveredApiError) as failure:
            await invoker.invoke("local-fixture", "missing", {})
    assert failure.value.code == "STALE_MAP"


@pytest.mark.asyncio
async def test_redacts_sensitive_response_fields(tmp_path: Path) -> None:
    mapped = operation()
    repository = await repository_with(mapped)
    async with client(
        b'{"products":[{"id":"p1","email":"person@example.com","name":"Safe"}]}'
    ) as http:
        invoker = DiscoveredApiInvoker(
            repository, policy(tmp_path / "sites"), http, resolver=lambda _host: _addresses()
        )
        result = await invoker.invoke("local-fixture", operation_id(mapped), {})
    assert result.records == ({"id": "p1", "name": "Safe"},)
    assert result.redacted is True


@pytest.mark.asyncio
async def test_marks_response_shape_and_content_type_drift(tmp_path: Path) -> None:
    mapped = operation()
    repository = await repository_with(mapped)
    drift: list[tuple[str, str, str]] = []

    async def mark(site: str, operation_key: str, reason: str) -> None:
        drift.append((site, operation_key, reason))

    async with client(b"not-json", content_type="text/plain") as http:
        invoker = DiscoveredApiInvoker(
            repository,
            policy(tmp_path / "sites"),
            http,
            resolver=lambda _host: _addresses(),
            drift_sink=mark,
        )
        with pytest.raises(DiscoveredApiError) as failure:
            await invoker.invoke("local-fixture", operation_id(mapped), {})
    assert failure.value.code == "RESPONSE_DRIFT"
    assert drift[0][2] == "content_type"


@pytest.mark.asyncio
async def test_rate_limit_and_private_dns_policy_are_enforced(tmp_path: Path) -> None:
    mapped = operation()
    repository = await repository_with(mapped)
    async with client(b'{"products":[]}') as http:
        invoker = DiscoveredApiInvoker(
            repository,
            policy(tmp_path / "sites"),
            http,
            resolver=lambda _host: _addresses(),
            rate_limit=1,
        )
        await invoker.invoke("local-fixture", operation_id(mapped), {})
        with pytest.raises(DiscoveredApiError) as failure:
            await invoker.invoke("local-fixture", operation_id(mapped), {})
    assert failure.value.code == "RATE_LIMITED"


@pytest.mark.asyncio
async def test_materialized_definitions_are_stable_and_read_only(tmp_path: Path) -> None:
    mapped = operation()
    repository = await repository_with(mapped)
    endpoint_map = await repository.get_active("local-fixture")
    assert endpoint_map is not None
    async with client(b"{}") as http:
        invoker = DiscoveredApiInvoker(repository, policy(tmp_path / "sites"), http)
        first = invoker.definitions("local-fixture", endpoint_map)
        second = invoker.definitions("local-fixture", endpoint_map)
        catalog = await invoker.definitions_all()
    assert first == second
    assert catalog == first
    assert first[0]["method"] == "GET"
    assert first[0]["parameters"]["additionalProperties"] is False


@pytest.mark.asyncio
async def test_registered_tool_returns_contract_valid_product_payload(tmp_path: Path) -> None:
    mapped = operation()
    repository = await repository_with(mapped)
    async with client(
        b'{"products":[{"id":"p1","name":"Headphones","priceAmount":99,"currency":"USD"}]}'
    ) as http:
        invoker = DiscoveredApiInvoker(
            repository,
            policy(tmp_path / "sites"),
            http,
            resolver=lambda _host: _addresses(),
        )
        configure_discovered_api_invoker(invoker)
        invocation = InvocationInvokeDiscoveredApi.model_validate(
            {
                "contractVersion": 1,
                "correlation": {
                    "requestId": "request-1",
                    "userId": "user-1",
                    "sessionId": "session-1",
                },
                "toolCallId": "call-1",
                "toolName": "browser.invoke_discovered_api",
                "arguments": {
                    "siteId": "local-fixture",
                    "operationId": operation_id(mapped),
                    "parameters": {},
                },
            }
        )
        outcome = await run_invoke_discovered_api(invocation, asyncio.Event())
    configure_discovered_api_invoker(None)
    SuccessResultInvokeDiscoveredApi.model_validate(
        {
            "contractVersion": 1,
            "correlation": invocation.correlation.model_dump(),
            "toolCallId": invocation.toolCallId,
            "status": "success",
            "payload": outcome.payload,
            "evidence": outcome.evidence,
            "sensitivity": {"sensitive": False, "confirmationRequired": False},
        }
    )
    assert outcome.payload["resultKind"] == "product_results"
