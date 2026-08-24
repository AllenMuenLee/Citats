"""Strict schema for one pilot-site governance record.

A site record (`config/sites/<site-id>.yaml`, repo root) declares which
site an AI-native-browser feature is allowed to run network-capture
("discovery") and endpoint replay ("invocation") against, and under what
constraints. This module is a pure data/validation layer -- it does not
perform any network capture, endpoint inference, or invocation itself;
those are separate, independent features that will consult
`browser_service.sites.loader.SitePolicyLoader` before doing anything.

Design notes (the "why" behind the stricter rules):

* **Only `GET`/`HEAD` may ever be present in `allowed_methods`.** This
  phase (P03, API Discovery) never executes state-changing requests, so
  any other HTTP method is rejected outright at the schema level -- a
  record with `POST` in it fails to load at all rather than merely being
  ignored at match time.
* **Wildcards are bounded, never open-ended.** A bare `"*"` (matches
  everything) or a `"**"` segment (matches an arbitrary number of path
  segments) would make the allowlist meaningless, so both are rejected.
  The only wildcard forms permitted are a single leading `"*."` label for
  `allowed_subdomains` (one arbitrary subdomain label in front of a fixed,
  non-empty suffix, e.g. `"*.api"`) and a single trailing `"/*"` segment
  for `allowed_routes` (one arbitrary path segment after a fixed,
  non-empty prefix, e.g. `"/v1/users/*"`). Both still require a concrete,
  non-empty anchor -- `"*"` and `"/*"` alone are rejected as overly broad.
* **`decision: approved` requires a human signature.** `reviewer` and
  `decision_date` must both be present -- there is no path to an
  auto-approved site.
* **Credential heuristic never gets weakened for our own fixture.** If it
  ever fires on `config/sites/local-fixture.yaml`, that is a bug in the
  fixture data, not a false positive to special-case away.
"""

from __future__ import annotations

import re
from datetime import date
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

CURRENT_SCHEMA_VERSION = 1

SAFE_METHODS = frozenset({"GET", "HEAD"})

# HTTP methods this phase must never approve, listed explicitly so a
# rejection message can name the exact unsafe method rather than just
# saying "not GET/HEAD".
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE", "CONNECT", "OPTIONS", "TRACE"})

_EARLIEST_SANE_DATE = date(2000, 1, 1)

_SITE_ID_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

_DOMAIN_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
_DOMAIN_PATTERN = re.compile(rf"^{_DOMAIN_LABEL}(?:\.{_DOMAIN_LABEL})*$")
_WILDCARD_SUBDOMAIN_PATTERN = re.compile(rf"^\*\.{_DOMAIN_LABEL}(?:\.{_DOMAIN_LABEL})*$")

_ROUTE_SEGMENT = r"[A-Za-z0-9._~-]+"
_EXACT_ROUTE_PATTERN = re.compile(rf"^/(?:{_ROUTE_SEGMENT}(?:/{_ROUTE_SEGMENT})*)?$")
_WILDCARD_ROUTE_PATTERN = re.compile(rf"^/{_ROUTE_SEGMENT}(?:/{_ROUTE_SEGMENT})*/\*$")

# Credential-shaped *key names* -- mirrors the intent of
# `browser_service.contracts._validators.FORBIDDEN_FIELD_NAME_PATTERN`
# (same idea: names that mean "secret material", not any specific value).
CREDENTIAL_KEY_PATTERN = re.compile(
    r"(password|passwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|credential)",
    re.IGNORECASE,
)

# Credential-shaped *values* -- either a well-known secret-token prefix, or
# a long, high-entropy-looking run of letters+digits with no whitespace or
# separators. This is a heuristic, not a proof: it deliberately favors
# false positives (reject a plausible-looking token) over false negatives
# (let a real secret slip into a committed YAML file).
_KNOWN_TOKEN_PREFIX_PATTERN = re.compile(
    r"(sk-|pk_live_|pk_test_|gh[pousr]_|AKIA|ASIA|xox[baprs]-|AIza|Bearer\s)"
)
_HIGH_ENTROPY_VALUE_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])(?=[A-Za-z0-9_-]{32,}(?:$|[^A-Za-z0-9_-]))"
    r"(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}"
)


class DataClassification(StrEnum):
    PUBLIC = "public"
    INTERNAL = "internal"
    SENSITIVE = "sensitive"


class Decision(StrEnum):
    APPROVED = "approved"
    PENDING = "pending"
    REJECTED = "rejected"


class SitePolicyError(ValueError):
    """Base class for site-governance policy errors."""


class CredentialShapedValueError(SitePolicyError):
    """Raised when a site record contains a credential-shaped key or value."""


def normalize_domain(domain: str) -> str:
    """Lowercase and IDN-normalize (punycode) a single domain string.

    Raises `ValueError` if `domain` is not a syntactically valid domain
    once normalized (invalid label, empty label, failed IDNA encoding).
    """
    candidate = domain.strip().lower()
    if not candidate:
        raise ValueError("empty_domain")
    try:
        normalized = candidate.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise ValueError(f"invalid_idn_domain: {domain}") from exc
    if not _DOMAIN_PATTERN.match(normalized):
        raise ValueError(f"invalid_domain_syntax: {domain}")
    return normalized


def normalize_subdomain_entry(entry: str) -> str:
    """Normalize one `allowed_subdomains` entry, preserving a leading `*.`."""
    candidate = entry.strip().lower()
    if candidate.startswith("*."):
        suffix = normalize_domain(candidate[2:])
        return f"*.{suffix}"
    return normalize_domain(candidate)


def scan_for_credential_shaped_keys(data: Any, *, _path: str = "$") -> list[str]:
    """Recursively find mapping keys that look like credential fields.

    Returns the list of dotted paths where a suspicious key was found (an
    empty list means none were found). Used both by the schema-level
    validator (on the parsed record) and by the loader/lint script (on
    the raw YAML mapping, before Pydantic ever sees it) so an unexpected
    extra key is reported with a clear reason instead of a generic
    "extra fields not permitted" error.
    """
    findings: list[str] = []
    if isinstance(data, dict):
        for key, value in data.items():
            key_str = str(key)
            child_path = f"{_path}.{key_str}"
            if CREDENTIAL_KEY_PATTERN.search(key_str):
                findings.append(child_path)
            findings.extend(scan_for_credential_shaped_keys(value, _path=child_path))
    elif isinstance(data, list):
        for index, item in enumerate(data):
            findings.extend(scan_for_credential_shaped_keys(item, _path=f"{_path}[{index}]"))
    return findings


def scan_for_credential_shaped_values(data: Any, *, _path: str = "$") -> list[str]:
    """Recursively find string values that look like a secret token."""
    findings: list[str] = []
    if isinstance(data, str):
        if _KNOWN_TOKEN_PREFIX_PATTERN.search(data) or _HIGH_ENTROPY_VALUE_PATTERN.search(data):
            findings.append(_path)
    elif isinstance(data, dict):
        for key, value in data.items():
            findings.extend(scan_for_credential_shaped_values(value, _path=f"{_path}.{key}"))
    elif isinstance(data, list):
        for index, item in enumerate(data):
            findings.extend(scan_for_credential_shaped_values(item, _path=f"{_path}[{index}]"))
    return findings


def assert_no_credential_shapes(data: Any) -> None:
    """Raise `CredentialShapedValueError` if `data` contains a
    credential-shaped key name or a credential-shaped string value.
    """
    key_findings = scan_for_credential_shaped_keys(data)
    value_findings = scan_for_credential_shaped_values(data)
    findings = key_findings + value_findings
    if findings:
        raise CredentialShapedValueError(
            "credential-shaped content found at: " + ", ".join(sorted(findings))
        )


class SitePolicy(BaseModel):
    """One validated, normalized `config/sites/<site-id>.yaml` record."""

    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    schema_version: int = Field(default=CURRENT_SCHEMA_VERSION)
    site_id: str
    canonical_domain: str
    allowed_subdomains: list[str] = Field(default_factory=list)
    allowed_routes: list[str]
    allowed_methods: list[str]
    discovery_permitted: bool
    replay_permitted: bool
    data_classification: DataClassification
    retention_days: int = Field(ge=1, le=3650)
    owner: str = Field(min_length=1)
    reviewer: str | None = None
    decision: Decision
    decision_date: date | None = None
    review_date: date | None = None
    kill_switch_enabled: bool = False

    @field_validator("schema_version")
    @classmethod
    def _validate_schema_version(cls, value: int) -> int:
        if value != CURRENT_SCHEMA_VERSION:
            raise ValueError(
                f"unsupported_schema_version: got {value}, expected {CURRENT_SCHEMA_VERSION}"
            )
        return value

    @field_validator("site_id")
    @classmethod
    def _validate_site_id(cls, value: str) -> str:
        candidate = value.strip().lower()
        if not _SITE_ID_PATTERN.match(candidate) or len(candidate) > 63:
            raise ValueError(f"invalid_site_id: {value!r}")
        return candidate

    @field_validator("canonical_domain")
    @classmethod
    def _validate_canonical_domain(cls, value: str) -> str:
        return normalize_domain(value)

    @field_validator("allowed_subdomains")
    @classmethod
    def _validate_allowed_subdomains(cls, value: list[str]) -> list[str]:
        normalized: list[str] = []
        for entry in value:
            candidate = entry.strip().lower()
            if candidate in {"*", "**"}:
                raise ValueError(f"overly_broad_subdomain_wildcard: {entry!r}")
            if candidate.startswith("*."):
                if not _WILDCARD_SUBDOMAIN_PATTERN.match(candidate):
                    raise ValueError(f"invalid_subdomain_wildcard: {entry!r}")
                normalized.append(normalize_subdomain_entry(candidate))
                continue
            if "*" in candidate:
                raise ValueError(f"unbounded_subdomain_wildcard: {entry!r}")
            normalized.append(normalize_subdomain_entry(candidate))
        return normalized

    @field_validator("allowed_routes")
    @classmethod
    def _validate_allowed_routes(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError("allowed_routes_empty")
        normalized: list[str] = []
        for entry in value:
            candidate = entry.strip()
            if candidate in {"*", "/*"}:
                raise ValueError(f"overly_broad_route_wildcard: {entry!r}")
            if "**" in candidate:
                raise ValueError(f"unbounded_route_wildcard: {entry!r}")
            if candidate.endswith("/*"):
                if not _WILDCARD_ROUTE_PATTERN.match(candidate):
                    raise ValueError(f"invalid_route_wildcard: {entry!r}")
                normalized.append(candidate)
                continue
            if "*" in candidate:
                raise ValueError(f"unbounded_route_wildcard: {entry!r}")
            if not _EXACT_ROUTE_PATTERN.match(candidate):
                raise ValueError(f"invalid_route: {entry!r}")
            normalized.append(candidate)
        return normalized

    @field_validator("allowed_methods")
    @classmethod
    def _validate_allowed_methods(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError("allowed_methods_empty")
        normalized: list[str] = []
        seen: set[str] = set()
        for entry in value:
            method = entry.strip().upper()
            if method in UNSAFE_METHODS or method not in SAFE_METHODS:
                raise ValueError(f"unsafe_method_not_permitted_this_phase: {entry!r}")
            if method not in seen:
                seen.add(method)
                normalized.append(method)
        return normalized

    @field_validator("decision_date", "review_date")
    @classmethod
    def _validate_date_bounds(cls, value: date | None) -> date | None:
        if value is None:
            return value
        if value < _EARLIEST_SANE_DATE:
            raise ValueError(f"invalid_date_too_old: {value.isoformat()}")
        if value > date.today():
            raise ValueError(f"invalid_date_in_future: {value.isoformat()}")
        return value

    @model_validator(mode="after")
    def _validate_approval_requires_signoff(self) -> SitePolicy:
        if self.decision == Decision.APPROVED:
            if self.reviewer is None or not self.reviewer.strip():
                raise ValueError("approved_decision_requires_reviewer")
            if self.decision_date is None:
                raise ValueError("approved_decision_requires_decision_date")
        return self

    @model_validator(mode="after")
    def _validate_no_credential_shapes(self) -> SitePolicy:
        assert_no_credential_shapes(self.model_dump(mode="json"))
        return self

    def route_and_method_allowed(self, method: str, path: str) -> bool:
        """Exact (not prefix-fuzzy) route+method match against this record.

        Does NOT consider `decision`, `kill_switch_enabled`, or
        `replay_permitted` -- callers must check those separately (see
        `browser_service.sites.loader.SitePolicyLoader.is_replay_allowed`,
        which composes this with the rest of the policy).
        """
        normalized_method = method.strip().upper()
        if normalized_method not in SAFE_METHODS:
            return False
        if normalized_method not in self.allowed_methods:
            return False
        return any(_route_matches(pattern, path) for pattern in self.allowed_routes)


def _route_matches(pattern: str, path: str) -> bool:
    if not pattern.endswith("/*"):
        return pattern == path
    prefix = pattern[: -len("*")]
    if not path.startswith(prefix):
        return False
    remainder = path[len(prefix) :]
    return len(remainder) > 0 and "/" not in remainder
