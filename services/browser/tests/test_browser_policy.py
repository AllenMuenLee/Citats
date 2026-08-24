"""Unit tests for the read-only navigation URL safety policy.

No browser is needed for these -- they exercise ``UrlPolicy.check`` in
isolation (scheme/credential/fragment rules, DNS resolution, and blocked
address ranges).
"""

from __future__ import annotations

import asyncio

import pytest

from browser_service.browser.policy import PolicyViolation, UrlPolicy, UrlPolicyConfig


def check(policy: UrlPolicy, url: str) -> str:
    return asyncio.run(policy.check(url))


def violation_reason(policy: UrlPolicy, url: str) -> str:
    with pytest.raises(PolicyViolation) as excinfo:
        check(policy, url)
    return excinfo.value.reason


def test_allows_public_https_url() -> None:
    policy = UrlPolicy()
    assert check(policy, "https://example.com/path") == "https://example.com/path"


def test_rejects_non_http_schemes() -> None:
    policy = UrlPolicy()
    assert violation_reason(policy, "file:///etc/passwd") == "unsupported_scheme"
    assert violation_reason(policy, "javascript:alert(1)") == "unsupported_scheme"
    assert violation_reason(policy, "ftp://example.com/file") == "unsupported_scheme"
    assert violation_reason(policy, "chrome://settings") == "unsupported_scheme"


def test_rejects_credentials_in_url() -> None:
    policy = UrlPolicy()
    assert violation_reason(policy, "https://user:pass@example.com/") == "credentials_in_url"


def test_rejects_fragment_when_disallowed() -> None:
    policy = UrlPolicy(UrlPolicyConfig(allow_fragments=False))
    assert violation_reason(policy, "https://example.com/#frag") == "fragment_not_allowed"


def test_allows_fragment_by_default() -> None:
    policy = UrlPolicy()
    assert check(policy, "https://example.com/#frag") == "https://example.com/#frag"


def test_blocks_ipv4_loopback_literal() -> None:
    policy = UrlPolicy()
    assert violation_reason(policy, "http://127.0.0.1/") == "blocked_address_range"


def test_blocks_private_ranges() -> None:
    policy = UrlPolicy()
    for host in ("10.1.2.3", "172.16.0.5", "192.168.1.1"):
        assert violation_reason(policy, f"http://{host}/") == "blocked_address_range"


def test_blocks_cloud_metadata_address() -> None:
    policy = UrlPolicy()
    assert violation_reason(policy, "http://169.254.169.254/latest/meta-data/") == (
        "blocked_address_range"
    )


def test_blocks_ipv6_loopback_and_link_local_and_unique_local() -> None:
    policy = UrlPolicy()
    assert violation_reason(policy, "http://[::1]/") == "blocked_address_range"
    assert violation_reason(policy, "http://[fe80::1]/") == "blocked_address_range"
    assert violation_reason(policy, "http://[fc00::1]/") == "blocked_address_range"


def test_blocks_ipv4_mapped_ipv6_loopback() -> None:
    policy = UrlPolicy()
    assert violation_reason(policy, "http://[::ffff:127.0.0.1]/") == "blocked_address_range"


def test_missing_hostname_rejected() -> None:
    policy = UrlPolicy()
    assert violation_reason(policy, "http:///path") == "missing_hostname"


def test_dns_resolution_failure_rejected() -> None:
    policy = UrlPolicy()
    assert (
        violation_reason(policy, "http://this-host-should-not-resolve.invalid/")
        == "dns_resolution_failed"
    )


def test_test_only_allowed_hosts_bypasses_loopback_block() -> None:
    policy = UrlPolicy(test_only_allowed_hosts=frozenset({"127.0.0.1"}))
    assert check(policy, "http://127.0.0.1:9999/page") == "http://127.0.0.1:9999/page"


def test_test_only_allowed_hosts_does_not_bypass_scheme_check() -> None:
    policy = UrlPolicy(test_only_allowed_hosts=frozenset({"127.0.0.1"}))
    assert violation_reason(policy, "file://127.0.0.1/etc/passwd") == "unsupported_scheme"


def test_test_only_allowed_hosts_is_never_read_from_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # There is no environment variable or config path that can populate
    # test_only_allowed_hosts -- it is a plain constructor kwarg with an
    # empty default. Setting arbitrary env vars must not activate it.
    monkeypatch.setenv("BROWSER_SERVICE_TEST_ALLOWED_HOSTS", "127.0.0.1")
    monkeypatch.setenv("TEST_ONLY_ALLOWED_HOSTS", "127.0.0.1")
    policy = UrlPolicy()
    assert violation_reason(policy, "http://127.0.0.1/") == "blocked_address_range"
