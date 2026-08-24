from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import socket
import time
from collections import defaultdict, deque
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import quote, urlencode, urljoin, urlsplit

import httpx

from browser_service.endpoint_map.models import NormalizedOperation
from browser_service.endpoint_map.repository import EndpointMapRepository
from browser_service.network.redactor import evaluate_field
from browser_service.sites.loader import SitePolicyLoader

MAX_RESPONSE_BYTES = 1_000_000
MAX_RECORDS = 100
MAX_FIELDS = 80
MAX_DEPTH = 3
MAX_STRING_LENGTH = 500
MAX_REDIRECTS = 5
DEFAULT_CONFIDENCE = 0.75


class DiscoveredApiError(Exception):
    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


@dataclass(frozen=True)
class DiscoveredApiResult:
    site_id: str
    operation_id: str
    map_version: str
    result_kind: str
    records: tuple[dict[str, Any], ...]
    source_url: str
    retrieved_at: str
    stale_after: str
    warnings: tuple[str, ...]
    redacted: bool
    truncated: bool


Resolver = Callable[[str], Awaitable[tuple[str, ...]]]
DriftSink = Callable[[str, str, str], Awaitable[None] | None]


def operation_id(operation: NormalizedOperation) -> str:
    raw = "\0".join(operation.operation_key).encode()
    return hashlib.sha256(raw).hexdigest()[:24]


async def _resolve(hostname: str) -> tuple[str, ...]:
    loop = asyncio.get_running_loop()
    records = await loop.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
    return tuple(sorted({str(record[4][0]) for record in records}))


def _validate_addresses(addresses: tuple[str, ...], *, allow_loopback: bool) -> None:
    if not addresses:
        raise DiscoveredApiError("POLICY_BLOCKED", "The approved host did not resolve.")
    for raw in addresses:
        address = ipaddress.ip_address(raw)
        blocked = (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_multicast
            or address.is_reserved
            or address.is_unspecified
        )
        if blocked and not (allow_loopback and address.is_loopback):
            raise DiscoveredApiError("POLICY_BLOCKED", "The resolved address is not permitted.")


def _expand_path(template: str, parameters: Mapping[str, Any]) -> tuple[str, set[str]]:
    used: set[str] = set()
    path = template
    while "{" in path:
        start = path.find("{")
        end = path.find("}", start + 1)
        if end < 0:
            raise DiscoveredApiError("STALE_MAP", "The active endpoint template is invalid.")
        key = path[start + 1 : end]
        value = parameters.get(key)
        if not key or not isinstance(value, (str, int)) or isinstance(value, bool):
            raise DiscoveredApiError("INVALID_ARGUMENTS", f"A value for '{key}' is required.")
        used.add(key)
        path = f"{path[:start]}{quote(str(value), safe='')}{path[end + 1 :]}"
    return path, used


def _shape_matches(value: Any, operation: NormalizedOperation) -> bool:
    expected = operation.response.body.kind
    if expected is None or expected == "empty":
        return value is None or value == ""
    if expected == "object" and not isinstance(value, dict):
        return False
    if expected == "array" and not isinstance(value, list):
        return False
    if expected == "primitive" and isinstance(value, (dict, list)):
        return False
    if expected == "object":
        required = {field.name for field in operation.response.body.keys if not field.optional}
        return required.issubset(value.keys())
    return True


def _sanitize(value: Any, *, depth: int = 0) -> tuple[Any, bool, bool]:
    if depth > MAX_DEPTH:
        return None, False, True
    if value is None or isinstance(value, (bool, int, float)):
        return value, False, False
    if isinstance(value, str):
        decision = evaluate_field("value", value)
        if not decision.keep:
            return None, True, False
        return value[:MAX_STRING_LENGTH], False, len(value) > MAX_STRING_LENGTH
    if isinstance(value, list):
        output: list[Any] = []
        redacted = False
        truncated = len(value) > MAX_RECORDS
        for item in value[:MAX_RECORDS]:
            clean, item_redacted, item_truncated = _sanitize(item, depth=depth + 1)
            output.append(clean)
            redacted = redacted or item_redacted
            truncated = truncated or item_truncated
        return output, redacted, truncated
    if isinstance(value, dict):
        output_dict: dict[str, Any] = {}
        redacted = False
        truncated = len(value) > MAX_FIELDS
        for key, item in list(value.items())[:MAX_FIELDS]:
            name = str(key)[:80]
            decision = evaluate_field(name, item)
            if not decision.keep:
                redacted = True
                continue
            clean, item_redacted, item_truncated = _sanitize(item, depth=depth + 1)
            output_dict[name] = clean
            redacted = redacted or item_redacted
            truncated = truncated or item_truncated or len(str(key)) > 80
        return output_dict, redacted, truncated
    return None, True, False


def _records(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict):
        for key in ("records", "items", "products", "itineraries", "flights", "results"):
            nested = value.get(key)
            if isinstance(nested, list):
                return [item for item in nested if isinstance(item, dict)]
        return [value]
    return []


def _result_kind(value: Any) -> str:
    if isinstance(value, dict):
        if isinstance(value.get("products"), list):
            return "product_results"
        if isinstance(value.get("flights"), list) or isinstance(value.get("itineraries"), list):
            return "flight_comparison"
    return "generic_records"


class DiscoveredApiInvoker:
    def __init__(
        self,
        repository: EndpointMapRepository,
        policies: SitePolicyLoader,
        client: httpx.AsyncClient,
        *,
        resolver: Resolver = _resolve,
        drift_sink: DriftSink | None = None,
        confidence_threshold: float = DEFAULT_CONFIDENCE,
        rate_limit: int = 20,
        rate_window_seconds: float = 60.0,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._repository = repository
        self._policies = policies
        self._client = client
        self._resolver = resolver
        self._drift_sink = drift_sink
        self._confidence_threshold = confidence_threshold
        self._rate_limit = rate_limit
        self._rate_window_seconds = rate_window_seconds
        self._now = now
        self._requests: defaultdict[str, deque[float]] = defaultdict(deque)

    async def invoke(
        self,
        site_id: str,
        requested_operation_id: str,
        parameters: Mapping[str, Any],
        *,
        cancelled: asyncio.Event | None = None,
        result_kind: str | None = None,
    ) -> DiscoveredApiResult:
        endpoint_map = await self._repository.get_active(site_id)
        if endpoint_map is None:
            raise DiscoveredApiError("STALE_MAP", "No active endpoint map is available.")
        operation = next(
            (
                item
                for item in endpoint_map.operations
                if operation_id(item) == requested_operation_id
            ),
            None,
        )
        if operation is None or operation.stale:
            raise DiscoveredApiError("STALE_MAP", "The requested endpoint mapping is unavailable.")
        if (
            operation.method not in {"GET", "HEAD"}
            or operation.confidence < self._confidence_threshold
        ):
            raise DiscoveredApiError("POLICY_BLOCKED", "The operation is not approved for replay.")

        path, used = _expand_path(operation.path_template, parameters)
        declared_query = {field.name for field in operation.parameters.query_parameters}
        unknown = set(parameters) - used - declared_query
        if unknown:
            raise DiscoveredApiError(
                "INVALID_ARGUMENTS", "Undeclared logical parameters were supplied."
            )
        missing = {
            field.name
            for field in operation.parameters.query_parameters
            if not field.optional and field.name not in parameters
        }
        if missing:
            raise DiscoveredApiError(
                "INVALID_ARGUMENTS", "Required logical parameters are missing."
            )
        query = [(key, parameters[key]) for key in sorted(declared_query & set(parameters))]
        url = f"{operation.origin}{path}"
        if query:
            url = f"{url}?{urlencode(query, doseq=True)}"
        self._consume_rate(site_id)
        response = await self._request(
            site_id,
            operation,
            url,
            cancelled=cancelled or asyncio.Event(),
        )
        content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
        if content_type not in {"application/json", "application/ld+json"}:
            await self._drift(site_id, requested_operation_id, "content_type")
            raise DiscoveredApiError("RESPONSE_DRIFT", "The endpoint response type changed.")
        if len(response.content) > MAX_RESPONSE_BYTES:
            raise DiscoveredApiError(
                "UPSTREAM_UNAVAILABLE", "The endpoint response exceeded its limit."
            )
        try:
            raw = response.json()
        except json.JSONDecodeError as exc:
            await self._drift(site_id, requested_operation_id, "invalid_json")
            raise DiscoveredApiError(
                "RESPONSE_DRIFT", "The endpoint response was invalid."
            ) from exc
        if response.status_code not in operation.response.status_codes or not _shape_matches(
            raw, operation
        ):
            await self._drift(site_id, requested_operation_id, "shape")
            raise DiscoveredApiError("RESPONSE_DRIFT", "The endpoint response shape changed.")
        clean, redacted, truncated = _sanitize(raw)
        result_records = _records(clean)[:MAX_RECORDS]
        retrieved = datetime.now(UTC)
        return DiscoveredApiResult(
            site_id=site_id,
            operation_id=requested_operation_id,
            map_version=endpoint_map.version_id,
            result_kind=result_kind or _result_kind(raw),
            records=tuple(result_records),
            source_url=str(response.url),
            retrieved_at=retrieved.isoformat(),
            stale_after=(retrieved + timedelta(minutes=5)).isoformat(),
            warnings=(),
            redacted=redacted,
            truncated=truncated or len(result_records) >= MAX_RECORDS,
        )

    def definitions(self, site_id: str, endpoint_map: Any) -> tuple[dict[str, Any], ...]:
        definitions: list[dict[str, Any]] = []
        for operation in endpoint_map.operations:
            hostname = urlsplit(operation.origin).hostname
            path_keys = {
                segment[1:-1]
                for segment in operation.path_template.split("/")
                if segment.startswith("{") and segment.endswith("}")
            }
            properties = {key: {"type": ["string", "number"]} for key in sorted(path_keys)}
            required = sorted(path_keys)
            for field in operation.parameters.query_parameters:
                properties[field.name] = {"type": ["string", "number", "boolean"]}
                if not field.optional:
                    required.append(field.name)
            if (
                operation.method in {"GET", "HEAD"}
                and not operation.stale
                and operation.confidence >= self._confidence_threshold
                and hostname is not None
                and self._policies.is_replay_allowed(
                    site_id, operation.method, operation.path_template, hostname
                )
            ):
                definitions.append(
                    {
                        "siteId": site_id,
                        "operationId": operation_id(operation),
                        "method": operation.method,
                        "resultKind": self._definition_result_kind(operation),
                        "parameters": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": properties,
                            "required": sorted(set(required)),
                        },
                    }
                )
        return tuple(definitions)

    async def definitions_all(self) -> tuple[dict[str, Any], ...]:
        definitions: list[dict[str, Any]] = []
        for endpoint_map in await self._repository.list_active():
            definitions.extend(self.definitions(endpoint_map.site_id, endpoint_map))
        return tuple(definitions)

    @staticmethod
    def _definition_result_kind(operation: NormalizedOperation) -> str:
        keys = {field.name for field in operation.response.body.keys}
        if "products" in keys:
            return "product_results"
        if keys & {"flights", "itineraries"}:
            return "flight_comparison"
        return "generic_records"

    async def _request(
        self,
        site_id: str,
        operation: NormalizedOperation,
        initial_url: str,
        *,
        cancelled: asyncio.Event,
    ) -> httpx.Response:
        url = initial_url
        for redirect_count in range(MAX_REDIRECTS + 1):
            split = urlsplit(url)
            if split.scheme not in {"http", "https"} or not split.hostname:
                raise DiscoveredApiError("POLICY_BLOCKED", "The endpoint URL is invalid.")
            if f"{split.scheme}://{split.netloc}" != operation.origin:
                raise DiscoveredApiError("POLICY_BLOCKED", "The endpoint origin changed.")
            if not self._policies.is_replay_allowed(
                site_id, operation.method, split.path, split.hostname
            ):
                raise DiscoveredApiError("POLICY_BLOCKED", "Site policy blocked endpoint replay.")
            addresses = await self._resolver(split.hostname)
            _validate_addresses(addresses, allow_loopback=site_id == "local-fixture")
            if cancelled.is_set():
                raise DiscoveredApiError(
                    "CANCELLED", "The endpoint request was cancelled.", retryable=True
                )
            try:
                request_task = asyncio.create_task(
                    self._fetch_once(operation.method, url)
                )
                cancel_task = asyncio.create_task(cancelled.wait())
                done, pending = await asyncio.wait(
                    {request_task, cancel_task},
                    timeout=15.0,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in pending:
                    task.cancel()
                if not done:
                    raise DiscoveredApiError(
                        "TIMEOUT", "The endpoint request timed out.", retryable=True
                    )
                if cancel_task in done and cancelled.is_set():
                    request_task.cancel()
                    raise DiscoveredApiError(
                        "CANCELLED", "The endpoint request was cancelled.", retryable=True
                    )
                response = request_task.result()
            except httpx.TimeoutException as exc:
                raise DiscoveredApiError(
                    "TIMEOUT", "The endpoint request timed out.", retryable=True
                ) from exc
            except httpx.HTTPError as exc:
                raise DiscoveredApiError(
                    "UPSTREAM_UNAVAILABLE", "The endpoint request failed.", retryable=True
                ) from exc
            if response.is_redirect:
                location = response.headers.get("location")
                if not location or redirect_count == MAX_REDIRECTS:
                    raise DiscoveredApiError("POLICY_BLOCKED", "The redirect was not permitted.")
                url = urljoin(url, location)
                continue
            return response
        raise DiscoveredApiError("POLICY_BLOCKED", "The redirect limit was exceeded.")

    async def _fetch_once(self, method: str, url: str) -> httpx.Response:
        async with self._client.stream(
            method,
            url,
            follow_redirects=False,
            timeout=httpx.Timeout(10.0, connect=5.0, read=10.0),
        ) as response:
            declared = response.headers.get("content-length")
            if declared and declared.isdigit() and int(declared) > MAX_RESPONSE_BYTES:
                raise DiscoveredApiError(
                    "UPSTREAM_UNAVAILABLE", "The endpoint response exceeded its limit."
                )
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > MAX_RESPONSE_BYTES:
                    raise DiscoveredApiError(
                        "UPSTREAM_UNAVAILABLE", "The endpoint response exceeded its limit."
                    )
            return httpx.Response(
                response.status_code,
                headers=response.headers,
                content=bytes(body),
                request=response.request,
            )

    def _consume_rate(self, site_id: str) -> None:
        now = self._now()
        bucket = self._requests[site_id]
        cutoff = now - self._rate_window_seconds
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()
        if len(bucket) >= self._rate_limit:
            raise DiscoveredApiError(
                "RATE_LIMITED", "The site replay rate limit was reached.", retryable=True
            )
        bucket.append(now)

    async def _drift(self, site_id: str, operation: str, reason: str) -> None:
        if self._drift_sink is None:
            return
        result = self._drift_sink(site_id, operation, reason)
        if result is not None:
            await result
