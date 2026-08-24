"""Read-only navigation URL safety policy.

Accepts only configured ``http``/``https`` URLs, rejects URLs carrying
embedded credentials, and resolves every hostname to its candidate IP
addresses -- blocking loopback, private, link-local, multicast, and
otherwise reserved ranges (this also covers the IPv4 link-local cloud
metadata address ``169.254.169.254``, since it falls inside
``169.254.0.0/16``). IPv6 loopback (``::1``), unique-local (``fc00::/7``),
and link-local (``fe80::/10``) ranges are blocked the same way, including
IPv4-mapped IPv6 literals (``::ffff:127.0.0.1``).

``UrlPolicy.check`` is the single entry point used both for the initial
navigation target and for revalidating every subsequent redirect hop --
callers (see ``navigation.py``) MUST call it again for each redirect
target rather than trusting only the first check.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from dataclasses import dataclass, field
from urllib.parse import urlsplit

DEFAULT_ALLOWED_SCHEMES = frozenset({"http", "https"})


class PolicyViolation(Exception):
    """Raised when a URL fails the read-only navigation safety policy."""

    def __init__(self, url: str, reason: str) -> None:
        super().__init__(f"Blocked URL ({reason}): {url}")
        self.url = url
        self.reason = reason


# Public alias -- navigation.py and integrators are expected to catch this.
BlockedUrlError = PolicyViolation


@dataclass(frozen=True)
class UrlPolicyConfig:
    """Immutable, credential-free policy configuration."""

    allowed_schemes: frozenset[str] = field(default_factory=lambda: DEFAULT_ALLOWED_SCHEMES)
    allow_fragments: bool = True


class UrlPolicy:
    """Validates URLs against the read-only browsing safety policy.

    ``test_only_allowed_hosts`` exists solely for this package's own tests:
    it lets test code point navigation at a local fixture HTTP server bound
    to loopback (e.g. ``127.0.0.1``) without weakening the loopback/private
    -network block for real deployments. It is a plain constructor
    parameter with an empty default -- it is NEVER read from an environment
    variable, config file, or any other production-reachable configuration
    path, so there is no way to activate it outside of test code that
    directly constructs a ``UrlPolicy`` instance itself.
    """

    def __init__(
        self,
        config: UrlPolicyConfig | None = None,
        *,
        test_only_allowed_hosts: frozenset[str] = frozenset(),
    ) -> None:
        self._config = config if config is not None else UrlPolicyConfig()
        self._test_only_allowed_hosts = test_only_allowed_hosts

    async def check(self, url: str) -> str:
        """Validate ``url``, returning it unchanged, or raise ``PolicyViolation``.

        Must be called again for every redirect hop, not only the initial
        navigation target.
        """
        parts = urlsplit(url)
        scheme = parts.scheme.lower()
        if scheme not in self._config.allowed_schemes:
            raise PolicyViolation(url, "unsupported_scheme")
        if parts.username is not None or parts.password is not None:
            raise PolicyViolation(url, "credentials_in_url")
        if parts.fragment and not self._config.allow_fragments:
            raise PolicyViolation(url, "fragment_not_allowed")

        try:
            hostname = parts.hostname
        except ValueError as exc:
            raise PolicyViolation(url, "malformed_host") from exc
        if not hostname:
            raise PolicyViolation(url, "missing_hostname")

        if hostname in self._test_only_allowed_hosts:
            return url

        try:
            port = parts.port
        except ValueError as exc:
            raise PolicyViolation(url, "malformed_port") from exc
        port = port or (443 if scheme == "https" else 80)

        # A literal IP address (bracketed IPv6 hostnames included -- urlsplit
        # strips the brackets from `.hostname`) never needs DNS resolution:
        # parse it directly rather than round-tripping it through the OS
        # resolver via a thread-pool executor call, which is unnecessary
        # I/O for an already-concrete address.
        literal_address = _try_parse_ip_literal(hostname)
        if literal_address is not None:
            if _is_blocked_address(_unwrap_ipv4_mapped(literal_address)):
                raise PolicyViolation(url, "blocked_address_range")
            return url

        try:
            loop = asyncio.get_running_loop()
            infos = await loop.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
        except OSError as exc:
            raise PolicyViolation(url, "dns_resolution_failed") from exc
        if not infos:
            raise PolicyViolation(url, "dns_resolution_failed")

        for info in infos:
            raw_address = str(info[4][0])
            address = ipaddress.ip_address(raw_address.split("%", 1)[0])
            if _is_blocked_address(_unwrap_ipv4_mapped(address)):
                raise PolicyViolation(url, "blocked_address_range")

        return url


def _try_parse_ip_literal(
    hostname: str,
) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        return ipaddress.ip_address(hostname.split("%", 1)[0])
    except ValueError:
        return None


def _unwrap_ipv4_mapped(
    address: ipaddress.IPv4Address | ipaddress.IPv6Address,
) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return address.ipv4_mapped
    return address


def _is_blocked_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_unspecified
        or address.is_reserved
    )
