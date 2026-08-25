"""Site-governance policy loader: the runtime side of the pilot-site
allowlist.

Loads and validates every `config/sites/*.yaml` file (repo root), and
exposes the two checks every future capture/invocation integrator must
call before doing anything against a pilot site:

* `is_capture_allowed(site_id)` -- may network capture ("discovery") even
  start for this site right now?
* `is_replay_allowed(site_id, method, path)` -- may this specific
  method+path be replayed against this site right now?

Both checks compose the same "is this site's approval currently active"
logic (`kill_switch_enabled` short-circuits everything; `decision` must be
`approved`; an approval past its staleness window is treated as expired)
so neither call path can accidentally skip the emergency disable
override -- that is the entire point of `_is_approval_active` being the
single place that logic lives.

This module never touches the network itself; it is a pure config
reader with an in-memory, bounded-TTL cache so repeated per-request
policy checks don't re-read and re-parse every YAML file on disk.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from datetime import date
from pathlib import Path

import yaml
from pydantic import ValidationError

from browser_service.sites.schema import (
    Decision,
    SitePolicy,
    scan_for_credential_shaped_keys,
)

logger = logging.getLogger("browser_service.sites.loader")

DEFAULT_TTL_SECONDS = 30.0
MAX_TTL_SECONDS = 300.0

# An `approved` decision older than this (relative to the loader's clock)
# is treated as expired -- i.e. as if it were `pending` -- rather than
# trusted forever. `None` disables the staleness check (tests that need
# to reason about kill-switch/decision behavior in isolation may want
# that; production callers should keep the default).
DEFAULT_APPROVAL_STALENESS_DAYS = 365


class SitePolicyLoadError(ValueError):
    """Raised when a `config/sites/*.yaml` file fails to parse or validate."""


def default_sites_root() -> Path:
    """Repo-root `config/sites/` directory, resolved from this file's
    own location (`services/browser/src/browser_service/sites/loader.py`)
    rather than a hardcoded absolute path.
    """
    return Path(__file__).resolve().parents[5] / "config" / "sites"


def parse_site_policy_file(path: Path, *, enforce_filename: bool = True) -> SitePolicy:
    """Parse and validate one `config/sites/<site-id>.yaml` file.

    Public so `scripts/lint_site_policies.py` can reuse the exact same
    parse/validate path `SitePolicyLoader` uses at runtime -- the lint
    script must never be able to drift from what the loader itself
    enforces.
    """
    text = path.read_text(encoding="utf-8")
    try:
        raw = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise SitePolicyLoadError(f"{path.name}: invalid_yaml: {exc}") from exc
    if not isinstance(raw, dict):
        raise SitePolicyLoadError(f"{path.name}: root_must_be_mapping")

    key_findings = scan_for_credential_shaped_keys(raw)
    if key_findings:
        raise SitePolicyLoadError(
            f"{path.name}: credential_shaped_key_found: {', '.join(key_findings)}"
        )

    try:
        policy = SitePolicy.model_validate(raw)
    except ValidationError as exc:
        raise SitePolicyLoadError(f"{path.name}: schema_validation_failed: {exc}") from exc

    expected_site_id = path.stem.lower()
    if enforce_filename and policy.site_id != expected_site_id:
        raise SitePolicyLoadError(
            f"{path.name}: site_id_filename_mismatch: file={expected_site_id!r} "
            f"site_id={policy.site_id!r}"
        )
    return policy


class SitePolicyLoader:
    """Loads, caches, and evaluates `config/sites/*.yaml` policy records."""

    def __init__(
        self,
        root: Path | str | None = None,
        *,
        ttl_seconds: float = DEFAULT_TTL_SECONDS,
        approval_staleness_days: int | None = DEFAULT_APPROVAL_STALENESS_DAYS,
        clock: Callable[[], float] | None = None,
        today_fn: Callable[[], date] | None = None,
        emergency_disabled: Callable[[str], bool] | None = None,
    ) -> None:
        if not 0 < ttl_seconds <= MAX_TTL_SECONDS:
            raise ValueError(f"ttl_seconds_must_be_between_0_and_{MAX_TTL_SECONDS:g}")
        self._root = Path(root) if root is not None else default_sites_root()
        self._ttl_seconds = ttl_seconds
        self._approval_staleness_days = approval_staleness_days
        self._clock = clock or time.monotonic
        self._today_fn = today_fn or date.today
        self._emergency_disabled = emergency_disabled or (lambda _site_id: False)
        self._cache: dict[str, SitePolicy] = {}
        self._cache_loaded_at: float | None = None

    def _load_all(self) -> dict[str, SitePolicy]:
        now = self._clock()
        if (
            self._cache_loaded_at is not None
            and (now - self._cache_loaded_at) < self._ttl_seconds
        ):
            return self._cache

        policies: dict[str, SitePolicy] = {}
        filename_mismatches: list[str] = []
        if self._root.is_dir():
            for path in sorted(self._root.glob("*.yaml")):
                policy = parse_site_policy_file(path, enforce_filename=False)
                if policy.site_id in policies:
                    raise SitePolicyLoadError(f"duplicate_site_id: {policy.site_id!r}")
                if policy.site_id != path.stem.lower():
                    filename_mismatches.append(
                        f"{path.name}: site_id_filename_mismatch: file={path.stem.lower()!r} "
                        f"site_id={policy.site_id!r}"
                    )
                policies[policy.site_id] = policy
        if filename_mismatches:
            raise SitePolicyLoadError(filename_mismatches[0])

        self._cache = policies
        self._cache_loaded_at = now
        return self._cache

    def invalidate(self) -> None:
        """Force the next call to re-read `config/sites/` from disk."""
        self._cache_loaded_at = None

    def get_policy(self, site_id: str) -> SitePolicy | None:
        return self._load_all().get(site_id.strip().lower())

    def _is_approval_active(self, policy: SitePolicy) -> bool:
        if policy.kill_switch_enabled or self._emergency_disabled(policy.site_id):
            return False
        if policy.decision != Decision.APPROVED:
            return False
        if self._approval_staleness_days is not None:
            if policy.decision_date is None:
                return False
            age_days = (self._today_fn() - policy.decision_date).days
            if age_days > self._approval_staleness_days:
                return False
        return True

    def is_capture_allowed(self, site_id: str, domain: str | None = None) -> bool:
        """Emergency-disable-aware check: may discovery/capture run for
        `site_id` right now? Callers MUST call this before starting any
        network capture for a site.
        """
        policy = self.get_policy(site_id)
        if self._emergency_disabled(site_id):
            return False
        if policy is None:
            return domain is not None
        if policy.kill_switch_enabled:
            return False
        if domain is not None and not policy.domain_allowed(domain):
            return False
        return policy.discovery_permitted

    def is_replay_allowed(
        self, site_id: str, method: str, path: str, domain: str | None = None
    ) -> bool:
        """Emergency-disable-aware check: may `method path` be replayed
        against `site_id` right now? Callers MUST call this before
        invoking any discovered endpoint.
        """
        policy = self.get_policy(site_id)
        if self._emergency_disabled(site_id):
            return False
        if policy is None:
            return (
                domain is not None
                and method.upper() in {"GET", "HEAD"}
                and path.startswith("/")
            )
        if policy.kill_switch_enabled:
            return False
        if not policy.replay_permitted:
            return False
        if domain is not None and not policy.domain_allowed(domain):
            return False
        return policy.route_and_method_allowed(method, path)
