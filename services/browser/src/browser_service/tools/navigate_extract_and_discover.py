"""The `browser.navigate_extract_and_discover` tool (P03-F05): composes one
real navigation with network capture (`browser_service.discovery`),
content extraction (`browser_service.extraction`), conservative endpoint-map
auto-activation, and closed action-affordance correlation into one bounded,
read-only operation.

Trusted, server-owned: the model and renderer only ever supply a URL and a
bounded free-text `goal` (unused server-side beyond validation -- it exists
so a future revision can bias extraction/observation without changing the
contract). Nothing here exposes CDP domains, capture filters, headers,
cookies, activation, or persistence policy to the caller, and nothing this
tool returns is itself executable: `discovery.operations` are opaque
read-only handles already gated by `DiscoveredApiInvoker`'s own
method/staleness/confidence/policy filter, and `discovery.actions` are
informational-only action-affordance descriptors (see
`packages/contracts/src/tools/action-affordance.ts`), never tools.
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from typing import Any
from urllib.parse import urlsplit

from browser_service.browser import (
    BrowserLifecycleManager,
    NavigationBlockedError,
    NavigationCancelledError,
    NavigationError,
    NavigationService,
    NavigationTimeoutError,
    ResponseTooLargeError,
    TooManyRedirectsError,
    UrlPolicy,
)
from browser_service.contracts import InvocationNavigateExtractAndDiscover
from browser_service.discovered_api.invoker import DEFAULT_CONFIDENCE, operation_id
from browser_service.discovery import DiscoveryResult, DiscoveryService
from browser_service.endpoint_map.models import DriftAlert, EndpointMapVersion, NormalizedOperation
from browser_service.endpoint_map.repository import EndpointMapRepository
from browser_service.endpoint_map.runtime import runtime_endpoint_map_repository
from browser_service.extraction import Affordance, AffordanceRole, extract_document
from browser_service.sites.loader import SitePolicyLoader
from browser_service.sites.schema import normalize_domain
from browser_service.tool_outcome import ToolExecutionError, ToolHandlerOutcome
from browser_service.tools._document_wire import (
    affordance_to_wire,
    build_evidence,
    chunk_to_wire,
    metadata_to_wire,
    truncation_to_wire,
    warning_to_wire,
)
from browser_service.tools._lifecycle import get_lifecycle_manager
from browser_service.tools.invoke_discovered_api import get_default_invoker

MAX_ACTION_AFFORDANCES = 50

# Mirrors `endpoint_map.inference._VARIABLE_SEGMENT` -- that constant is
# private to the inference module (which only ever *produces* templates),
# so the exact literal is duplicated here for *matching* a link's resolved
# path against an already-produced template, a different, much smaller
# concern than inference itself.
_VARIABLE_SEGMENT = "{var}"

# Ordered (phrase, intent) lexicon: longer/more-specific phrases are
# checked before the shorter phrases they contain (e.g. "cancel
# subscription" before bare "cancel") so the more specific intent wins.
# Deliberately small and closed, matching `ActionAffordanceIntentSchema`.
_INTENT_LEXICON: tuple[tuple[str, str], ...] = (
    ("add to cart", "purchase"),
    ("buy now", "purchase"),
    ("checkout", "purchase"),
    ("purchase", "purchase"),
    ("pay now", "purchase"),
    ("book now", "reserve"),
    ("reservation", "reserve"),
    ("reserve", "reserve"),
    ("cancel subscription", "delete"),
    ("cancel order", "delete"),
    ("unsubscribe", "delete"),
    ("delete", "delete"),
    ("remove", "delete"),
    ("cancel", "delete"),
    ("sign up", "authenticate"),
    ("signup", "authenticate"),
    ("sign in", "authenticate"),
    ("log in", "authenticate"),
    ("login", "authenticate"),
    ("register", "authenticate"),
    ("create account", "authenticate"),
    ("subscribe", "subscribe"),
    ("newsletter", "subscribe"),
    ("submit", "submit_form"),
    ("apply", "submit_form"),
    ("search", "submit_form"),
)


def _intent_for_label(label: str) -> str | None:
    normalized = label.strip().lower()
    for phrase, intent in _INTENT_LEXICON:
        if phrase in normalized:
            return intent
    return None


def _path_matches_template(path: str, template: str) -> bool:
    path_parts = path.split("/")
    template_parts = template.split("/")
    if len(path_parts) != len(template_parts):
        return False
    for path_part, template_part in zip(path_parts, template_parts, strict=True):
        if template_part != _VARIABLE_SEGMENT and path_part != template_part:
            return False
    return True


def _derive_site_id(hostname: str) -> str:
    """Opaque, filename-safe site identity for an unlisted public site:
    the normalized (lowercase, IDN-encoded) domain with `.` replaced by
    `-`. A `config/sites/<site-id>.yaml` policy record, if one exists for
    this domain, is expected to use the same convention.
    """
    return normalize_domain(hostname).replace(".", "-")


def _operation_id_from_key(key: tuple[str, str, str]) -> str:
    """Same opaque-handle formula as `discovered_api.invoker.operation_id`,
    re-derived from a bare `operation_key` tuple (a `DriftAlert` -- e.g. one
    describing a just-removed operation -- doesn't carry a full
    `NormalizedOperation` to hand that function directly).
    """
    raw = "\0".join(key).encode()
    return hashlib.sha256(raw).hexdigest()[:24]


def _drift_alert_to_wire(alert: DriftAlert) -> dict[str, Any]:
    return {
        "operationId": _operation_id_from_key(alert.operation_key),
        "kinds": [kind.value for kind in alert.kinds],
    }


def _qualifying_operations(
    version: EndpointMapVersion, site_id: str, policies: SitePolicyLoader
) -> list[NormalizedOperation]:
    """Mirrors `DiscoveredApiInvoker.definitions()`'s per-operation filter
    (safe method, not stale, high confidence, policy-permitted) -- used
    only to decide which just-observed operations are solid enough
    evidence for affordance correlation, independent of whether the whole
    candidate version ends up auto-activated.
    """
    qualifying: list[NormalizedOperation] = []
    for operation in version.operations:
        if operation.method not in {"GET", "HEAD"} or operation.stale:
            continue
        if operation.confidence < DEFAULT_CONFIDENCE:
            continue
        hostname = urlsplit(operation.origin).hostname
        if hostname is None:
            continue
        if not policies.is_replay_allowed(
            site_id, operation.method, operation.path_template, hostname
        ):
            continue
        qualifying.append(operation)
    return qualifying


def _match_operation(
    destination: str, operations: list[NormalizedOperation]
) -> NormalizedOperation | None:
    parsed = urlsplit(destination)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    for operation in operations:
        if operation.origin == origin and _path_matches_template(
            parsed.path, operation.path_template
        ):
            return operation
    return None


def _action_affordance(
    *,
    site_id: str,
    listing_handle: str,
    item_handle: str,
    intent: str,
    target_class: str,
    evidence: list[dict[str, Any]],
    confidence: float,
    required_capability: str,
) -> dict[str, Any]:
    raw = f"{site_id}\0{listing_handle}\0{item_handle}".encode()
    return {
        "actionId": f"action-{hashlib.sha256(raw).hexdigest()[:20]}",
        "intent": intent,
        "siteId": site_id,
        "sourceHandle": site_id,
        "listingHandle": listing_handle,
        "itemHandle": item_handle,
        "targetClass": target_class,
        "evidence": evidence,
        "confidence": confidence,
        "requiredCapability": required_capability,
    }


def _build_action_affordances(
    affordances: list[Affordance],
    *,
    site_id: str,
    listing_handle: str,
    qualifying_operations: list[NormalizedOperation],
) -> list[dict[str, Any]]:
    """Conservative affordance -> action correlation (P03-F05 steps 4-5).

    BUTTON/FORM affordances are always elevated with `targetClass=unknown`:
    a real navigate+discover run never simulates a click, so nothing ever
    ties one to a specific observed request. A LINK is elevated only when
    its label matches the closed mutating-intent lexicon (an ordinary
    "read more" link is just a normal navigable link, already free to
    visit via another tool call, and is never turned into an action
    affordance) -- and gets `targetClass=read_only_operation` only when its
    resolved same-origin destination matches an already-qualifying
    observed GET/HEAD template (explicit provenance); otherwise
    `external_workflow` (a stable link destination is itself provenance
    that *something* is there, just not yet observed/executable).
    """
    actions: list[dict[str, Any]] = []
    for affordance in affordances:
        if affordance.role in (AffordanceRole.BUTTON, AffordanceRole.FORM):
            intent = _intent_for_label(affordance.label) or (
                "submit_form" if affordance.role is AffordanceRole.FORM else "unknown_mutation"
            )
            actions.append(
                _action_affordance(
                    site_id=site_id,
                    listing_handle=listing_handle,
                    item_handle=affordance.affordance_id,
                    intent=intent,
                    target_class="unknown",
                    evidence=[{"kind": "dom_affordance", "affordanceId": affordance.affordance_id}],
                    confidence=0.3,
                    required_capability="action_execution",
                )
            )
            continue

        link_intent = _intent_for_label(affordance.label)
        if link_intent is None:
            continue  # an ordinary navigable link, not an action affordance
        intent = link_intent
        if affordance.destination is None:
            actions.append(
                _action_affordance(
                    site_id=site_id,
                    listing_handle=listing_handle,
                    item_handle=affordance.affordance_id,
                    intent=intent,
                    target_class="unknown",
                    evidence=[{"kind": "dom_affordance", "affordanceId": affordance.affordance_id}],
                    confidence=0.3,
                    required_capability="action_execution",
                )
            )
            continue
        matched = _match_operation(affordance.destination, qualifying_operations)
        if matched is not None:
            actions.append(
                _action_affordance(
                    site_id=site_id,
                    listing_handle=listing_handle,
                    item_handle=affordance.affordance_id,
                    intent=intent,
                    target_class="read_only_operation",
                    evidence=[
                        {"kind": "dom_affordance", "affordanceId": affordance.affordance_id},
                        {"kind": "observed_operation", "operationId": operation_id(matched)},
                    ],
                    confidence=min(matched.confidence, 0.9),
                    required_capability="none",
                )
            )
        else:
            actions.append(
                _action_affordance(
                    site_id=site_id,
                    listing_handle=listing_handle,
                    item_handle=affordance.affordance_id,
                    intent=intent,
                    target_class="external_workflow",
                    evidence=[{"kind": "stable_link_destination"}],
                    confidence=0.5,
                    required_capability="action_execution",
                )
            )
    return actions[:MAX_ACTION_AFFORDANCES]


async def _maybe_auto_activate(
    repository: EndpointMapRepository,
    policies: SitePolicyLoader,
    site_id: str,
    version: EndpointMapVersion,
    qualifying_operations: list[NormalizedOperation],
    warnings: list[str],
) -> None:
    """Conservative auto-activation (P03-F05 step 6): only a candidate with
    zero stale operations and at least one qualifying (safe-method,
    non-stale, high-confidence, policy-permitted) operation is ever
    activated -- and only as a whole version, never a single operation in
    isolation, matching the repository's own versioned-activation model.
    Never raises: activation is a best-effort enhancement, not something
    that should fail the whole discovery result.
    """
    if any(operation.stale for operation in version.operations) or not qualifying_operations:
        warnings.append(
            "Endpoint map candidate saved as pending; no read-only operation met the "
            "auto-activation bar."
        )
        return
    try:
        await repository.activate(
            site_id,
            version.version_id,
            actor="discovery-service",
            reason="auto-activated: high-confidence read-only operations",
        )
    except (ValueError, KeyError):
        warnings.append("Endpoint map candidate could not be auto-activated; it remains pending.")


async def run_navigate_extract_and_discover(
    invocation: InvocationNavigateExtractAndDiscover,
    cancelled: asyncio.Event,
    *,
    policy: UrlPolicy | None = None,
    manager: BrowserLifecycleManager | None = None,
    repository: EndpointMapRepository | None = None,
    policies: SitePolicyLoader | None = None,
    discovery_service: DiscoveryService | None = None,
) -> ToolHandlerOutcome:
    """Navigates to `invocation.arguments.url` once, capturing and
    inferring its read-only network traffic along the way, extracts
    bounded content (including descriptive-only affordances), and returns
    the `document`/`discovery` split.

    `policy`/`manager`/`repository`/`policies`/`discovery_service` are only
    ever supplied by this project's own tests, mirroring
    `run_navigate_and_extract`'s equivalent test-only parameters.
    `repository` is used both for auto-activation/`get_active` here *and*
    (via `configure_discovered_api_invoker`) for materializing
    `discovery.operations` -- a test overriding `repository` and/or
    `discovery_service` must keep both pointed at the same repository
    instance, or newly-activated operations won't resolve.
    """
    url = invocation.arguments.url
    hostname = urlsplit(url).hostname
    if not hostname:
        raise ToolExecutionError(
            "INVALID_ARGUMENTS", "The URL must include a hostname.", retryable=False
        )
    try:
        site_id = _derive_site_id(hostname)
    except ValueError as exc:
        raise ToolExecutionError(
            "INVALID_ARGUMENTS", "The URL's domain is invalid.", retryable=False
        ) from exc

    manager = manager if manager is not None else await get_lifecycle_manager()
    navigation_service = NavigationService(policy if policy is not None else UrlPolicy())
    policies = policies or SitePolicyLoader()
    repository = repository if repository is not None else runtime_endpoint_map_repository
    discovery_service = discovery_service or DiscoveryService(repository, policies)

    task_id = invocation.correlation.taskId or invocation.correlation.requestId
    session_id = invocation.correlation.sessionId

    total_start = time.monotonic()
    async with manager.isolated_context() as context:
        page = await context.open_page()

        discover_start = time.monotonic()
        try:
            discovery_result: DiscoveryResult = await discovery_service.discover(
                page,
                site_id=site_id,
                url=url,
                task_id=task_id,
                session_id=session_id,
                navigate=lambda p, u: navigation_service.navigate(p, u, cancelled=cancelled),
            )
        except PermissionError as exc:
            raise ToolExecutionError(
                "POLICY_BLOCKED",
                "Discovery was blocked by site or network policy.",
                retryable=False,
            ) from exc
        except ValueError as exc:
            raise ToolExecutionError(
                "INVALID_ARGUMENTS", "The discovery URL was invalid.", retryable=False
            ) from exc
        except NavigationBlockedError as exc:
            raise ToolExecutionError(
                "INVALID_ARGUMENTS",
                f"The URL was blocked by navigation policy ({exc.reason}).",
                retryable=False,
            ) from exc
        except NavigationCancelledError as exc:
            raise ToolExecutionError(
                "CANCELLED", "Navigation was cancelled.", retryable=True
            ) from exc
        except NavigationTimeoutError as exc:
            raise ToolExecutionError(
                "TIMEOUT", f"Navigation timed out ({exc.phase}).", retryable=True
            ) from exc
        except (TooManyRedirectsError, ResponseTooLargeError) as exc:
            raise ToolExecutionError(
                "UPSTREAM_UNAVAILABLE", "The page could not be safely retrieved.", retryable=False
            ) from exc
        except NavigationError as exc:
            raise ToolExecutionError(
                "UPSTREAM_UNAVAILABLE", "The page could not be retrieved.", retryable=True
            ) from exc
        navigation_and_discovery_ms = (time.monotonic() - discover_start) * 1000

        try:
            content_result = await navigation_service.get_content(page, cancelled=cancelled)
        except NavigationCancelledError as exc:
            raise ToolExecutionError(
                "CANCELLED", "Navigation was cancelled.", retryable=True
            ) from exc
        except NavigationTimeoutError as exc:
            raise ToolExecutionError(
                "TIMEOUT", f"Reading page content timed out ({exc.phase}).", retryable=True
            ) from exc
        except NavigationError as exc:
            raise ToolExecutionError(
                "UPSTREAM_UNAVAILABLE", "The page's content could not be read.", retryable=True
            ) from exc

        # Same fallback `NavigationService.navigate` itself uses -- `discover()`
        # only returns capture/inference results, not the `NavigationResult`,
        # so the final (post-redirect) URL is read directly off the page.
        final_url = page.target.url if page.target is not None and page.target.url else url

    extraction_start = time.monotonic()
    document = extract_document(content_result.content or "", final_url)
    extraction_ms = (time.monotonic() - extraction_start) * 1000
    total_ms = (time.monotonic() - total_start) * 1000

    qualifying_operations = _qualifying_operations(discovery_result.version, site_id, policies)
    warnings: list[str] = []
    await _maybe_auto_activate(
        repository, policies, site_id, discovery_result.version, qualifying_operations, warnings
    )
    active_version = await repository.get_active(site_id)

    invoker = get_default_invoker()
    operations = (
        list(invoker.definitions(site_id, active_version)) if active_version is not None else []
    )
    listing_handle = hashlib.sha256(final_url.encode()).hexdigest()[:24]
    actions = _build_action_affordances(
        document.affordances,
        site_id=site_id,
        listing_handle=listing_handle,
        qualifying_operations=qualifying_operations,
    )

    document_payload: dict[str, Any] = {
        "metadata": metadata_to_wire(document.metadata, None, None),
        "chunks": [chunk_to_wire(chunk) for chunk in document.chunks],
        "affordances": [affordance_to_wire(affordance) for affordance in document.affordances],
        "warnings": [warning_to_wire(warning) for warning in document.warnings],
        "truncations": [truncation_to_wire(truncation) for truncation in document.truncations],
        "timing": {
            "navigationMs": navigation_and_discovery_ms,
            "extractionMs": extraction_ms,
            "totalMs": total_ms,
        },
        "untrusted": True,
    }
    discovery_payload: dict[str, Any] = {
        "observationCount": discovery_result.observation_count,
        "operationCount": discovery_result.operation_count,
        "candidateMapVersion": discovery_result.version.version_id,
        "activeMapVersion": active_version.version_id if active_version is not None else None,
        "operations": operations,
        "actions": actions,
        "driftAlerts": [_drift_alert_to_wire(alert) for alert in discovery_result.drift_alerts],
        "warnings": warnings,
    }
    payload = {"document": document_payload, "discovery": discovery_payload}
    evidence = build_evidence(document, final_url)
    return ToolHandlerOutcome(payload=payload, evidence=evidence)


__all__ = ["run_navigate_extract_and_discover"]
