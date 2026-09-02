"""Real-browser tests for NavigationService against headless Chromium
(Playwright) and a local HTTP fixture server.

Covers successful navigation, URL-policy enforcement on the initial URL and
on every redirect hop, the redirect cap, and the response-size cap. The
redirect cases matter most: Playwright follows a server-side 3xx inside the
driver and reports the chain only afterwards, so ``NavigationService`` walks
the chain itself and validates each ``Location`` *before* requesting it --
these tests are what prove a disallowed hop is never contacted.

Timeout and cancellation control flow is covered separately, against a fake
page, in ``test_browser_navigation_timeouts.py``.
"""

from __future__ import annotations

import asyncio
import contextlib
import importlib.util
import urllib.parse
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from types import ModuleType

import pytest

from browser_service.browser.lifecycle import BrowserLifecycleManager, LifecycleConfig
from browser_service.browser.navigation import (
    NavigationBlockedError,
    NavigationLimits,
    NavigationService,
    ReadOnlyOperation,
    ResponseTooLargeError,
    TooManyRedirectsError,
)
from browser_service.browser.policy import UrlPolicy


def _load_fixture_server_module() -> ModuleType:
    # tests/fixtures/http/server.py is not part of any importable package
    # rooted outside this test file's own ownership boundary, so it is
    # loaded directly by file path rather than via a package import.
    path = Path(__file__).parent / "fixtures" / "http" / "server.py"
    spec = importlib.util.spec_from_file_location("browser_service_fixture_http_server", path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_fixture_server_module = _load_fixture_server_module()
fixture_http_server = _fixture_server_module.fixture_http_server


@pytest.fixture(scope="module")
def http_port() -> Iterator[int]:
    # Plain stdlib HTTP server, unrelated to the browser -- safe to share
    # across the whole module.
    with fixture_http_server() as port:
        yield port


def base_url(port: int) -> str:
    return f"http://127.0.0.1:{port}"


def redirect_url(port: int, target: str) -> str:
    return f"{base_url(port)}/redirect?to={urllib.parse.quote(target, safe='')}"


def make_service(port: int, limits: NavigationLimits | None = None) -> NavigationService:
    policy = UrlPolicy(test_only_allowed_hosts=frozenset({"127.0.0.1"}))
    return NavigationService(policy, limits)


def test_navigate_and_get_content_success(http_port: int) -> None:
    service = make_service(http_port)

    async def run() -> None:
        manager = BrowserLifecycleManager(LifecycleConfig(max_concurrent_contexts=1))
        try:
            async with manager.isolated_context() as ctx:
                page = await ctx.open_page()
                result = await service.navigate(page, f"{base_url(http_port)}/")
                assert result.operation is ReadOnlyOperation.NAVIGATE
                assert result.redirect_count == 0

                content_result = await service.get_content(page)
                assert content_result.operation is ReadOnlyOperation.GET_CONTENT
                assert "fixture-index" in (content_result.content or "")

                # get_content is safe to call again against the same,
                # already-navigated page.
                second = await service.get_content(page)
                assert "fixture-index" in (second.content or "")
        finally:
            await manager.shutdown()

    asyncio.run(run())


def test_navigate_rejects_disallowed_targets_before_touching_browser(http_port: int) -> None:
    bad_urls = [
        "file:///etc/passwd",
        "ftp://example.com/file",
        "http://127.0.0.1/",  # loopback, no test-only override for THIS policy
        "http://169.254.169.254/latest/meta-data/",
        "http://10.1.2.3/",
    ]

    async def run() -> None:
        manager = BrowserLifecycleManager(LifecycleConfig(max_concurrent_contexts=1))
        try:
            # Use a policy WITHOUT the test-only loopback override for the
            # loopback/metadata/private cases, matching real production
            # behavior; a single never-navigated page is reused across all
            # these checks since the policy check happens before any
            # Page.navigate call is ever issued.
            production_like_service = NavigationService(UrlPolicy())
            async with manager.isolated_context() as ctx:
                page = await ctx.open_page()
                for bad_url in bad_urls:
                    with pytest.raises(NavigationBlockedError) as excinfo:
                        await production_like_service.navigate(page, bad_url)
                    assert excinfo.value.url == bad_url
        finally:
            await manager.shutdown()

    asyncio.run(run())


def test_navigate_attaches_and_detaches_observer_around_navigation(http_port: int) -> None:
    """The trusted, server-only observer hook (P02-F01 step 3): attached
    immediately before navigation, detached in ``finally`` on success --
    later phases (e.g. page-observation capture, P03-F01) rely on this
    ordering to never miss the initial document's own state.
    """
    service = make_service(http_port)
    events: list[str] = []

    @contextlib.asynccontextmanager
    async def observer() -> AsyncIterator[None]:
        events.append("enter")
        try:
            yield
        finally:
            events.append("exit")

    async def run() -> None:
        manager = BrowserLifecycleManager(LifecycleConfig(max_concurrent_contexts=1))
        try:
            async with manager.isolated_context() as ctx:
                page = await ctx.open_page()
                result = await service.navigate(
                    page, f"{base_url(http_port)}/", observer=observer()
                )
                assert result.operation is ReadOnlyOperation.NAVIGATE
        finally:
            await manager.shutdown()

    asyncio.run(run())
    assert events == ["enter", "exit"]


def test_navigate_detaches_observer_when_blocked_before_touching_browser(http_port: int) -> None:
    """A policy-blocked URL never even reaches the observer -- the policy
    check happens first, matching the un-observed rejection path.
    """
    service = NavigationService(UrlPolicy())
    events: list[str] = []

    @contextlib.asynccontextmanager
    async def observer() -> AsyncIterator[None]:
        events.append("enter")
        try:
            yield
        finally:
            events.append("exit")

    async def run() -> None:
        manager = BrowserLifecycleManager(LifecycleConfig(max_concurrent_contexts=1))
        try:
            async with manager.isolated_context() as ctx:
                page = await ctx.open_page()
                with pytest.raises(NavigationBlockedError):
                    await service.navigate(page, "http://10.1.2.3/", observer=observer())
        finally:
            await manager.shutdown()

    asyncio.run(run())
    assert events == []


def test_redirect_to_blocked_target_is_rejected(http_port: int) -> None:
    service = make_service(http_port)
    target = redirect_url(http_port, "http://10.0.0.5/should-be-blocked")

    async def run() -> None:
        manager = BrowserLifecycleManager(LifecycleConfig(max_concurrent_contexts=1))
        try:
            async with manager.isolated_context() as ctx:
                page = await ctx.open_page()
                with pytest.raises(NavigationBlockedError) as excinfo:
                    await service.navigate(page, target)
                assert excinfo.value.reason == "blocked_address_range"
        finally:
            await manager.shutdown()

    asyncio.run(run())


def test_redirect_chain_later_hop_blocked_even_though_first_hop_allowed(http_port: int) -> None:
    service = make_service(http_port)
    # First hop redirects to another allowed, same-origin fixture URL; only
    # the SECOND hop points at a blocked target. The initial URL and the
    # first redirect target both pass the policy -- only the later hop must
    # cause the rejection, proving every hop is (re)validated, not just the
    # first.
    second_hop = redirect_url(http_port, "http://169.254.169.254/latest/meta-data/")
    first_hop = redirect_url(http_port, second_hop)

    async def run() -> None:
        manager = BrowserLifecycleManager(LifecycleConfig(max_concurrent_contexts=1))
        try:
            async with manager.isolated_context() as ctx:
                page = await ctx.open_page()
                with pytest.raises(NavigationBlockedError) as excinfo:
                    await service.navigate(page, first_hop)
                assert excinfo.value.reason == "blocked_address_range"
                assert "169.254.169.254" in excinfo.value.url
        finally:
            await manager.shutdown()

    asyncio.run(run())


def test_too_many_redirects_is_rejected(http_port: int) -> None:
    limited_service = make_service(http_port, NavigationLimits(max_redirects=1))
    # Three hops, all to allowed same-origin targets -- exceeds max_redirects=1.
    hop3 = f"{base_url(http_port)}/second.html"
    hop2 = redirect_url(http_port, hop3)
    hop1 = redirect_url(http_port, hop2)

    async def run() -> None:
        manager = BrowserLifecycleManager(LifecycleConfig(max_concurrent_contexts=1))
        try:
            async with manager.isolated_context() as ctx:
                page = await ctx.open_page()
                with pytest.raises(TooManyRedirectsError) as excinfo:
                    await limited_service.navigate(page, hop1)
                assert excinfo.value.max_redirects == 1
        finally:
            await manager.shutdown()

    asyncio.run(run())


def test_response_size_cap_is_enforced(http_port: int) -> None:
    limited_service = make_service(http_port, NavigationLimits(max_response_bytes=1_000))
    target = f"{base_url(http_port)}/oversized?bytes=5000"

    async def run() -> None:
        manager = BrowserLifecycleManager(LifecycleConfig(max_concurrent_contexts=1))
        try:
            async with manager.isolated_context() as ctx:
                page = await ctx.open_page()
                with pytest.raises(ResponseTooLargeError) as excinfo:
                    await limited_service.navigate(page, target)
                assert excinfo.value.max_bytes == 1_000
                assert excinfo.value.actual_bytes == 5_000
        finally:
            await manager.shutdown()

    asyncio.run(run())
