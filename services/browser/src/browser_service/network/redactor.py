"""Default-deny redactor for network capture (P03-F01).

Everything here is default-**deny**: a header/query/body field is only ever
retained (as a bare key *name* -- never a value) when it survives every
check below. There is no code path that copies a raw header/query/body
*value* into a returned object; values are only ever inspected in-memory
long enough to decide whether the *name* they came in under is safe to
keep, then discarded. This is stricter than ``browser_service.redaction``
(a fixed-key-name blocklist for structured logs): this module also flags
known-PII field-name patterns and high-entropy strings that look like
secrets regardless of what key they were found under.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass

MAX_KEY_NAME_LENGTH = 128

# Substrings (matched against a lowercased, non-alphanumeric-stripped key
# name) that mark a field default-denied regardless of its value. Broad and
# overlapping on purpose -- default-deny means false positives (e.g.
# "authorName") are an acceptable cost, false negatives on a real secret are
# not.
_SENSITIVE_KEY_SUBSTRINGS = frozenset(
    {
        "password",
        "passwd",
        "pwd",
        "secret",
        "token",
        "auth",
        "cookie",
        "session",
        "csrf",
        "xsrf",
        "apikey",
        "accesskey",
        "privatekey",
        "clientsecret",
        "credential",
        "bearer",
        "jwt",
        "signature",
        "ssn",
        "socialsecurity",
        "nationalid",
        "passport",
        "creditcard",
        "cardnumber",
        "cardnum",
        "cvv",
        "cvc",
        "pin",
        "email",
        "phone",
        "telephone",
        "mobile",
        "address",
        "street",
        "zipcode",
        "postalcode",
        "dob",
        "birthdate",
        "birthday",
        "firstname",
        "lastname",
        "fullname",
        "surname",
        "gender",
        "ipaddress",
    }
)

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")
_SSN_RE = re.compile(r"^\d{3}-?\d{2}-?\d{4}$")
_PHONE_DIGITS_RE = re.compile(r"^\+?[0-9()\-.\s]{9,20}$")

_HIGH_ENTROPY_CHARSET_RE = re.compile(r"^[A-Za-z0-9+/_=\-.]+$")
_HIGH_ENTROPY_MIN_LENGTH = 16
_HIGH_ENTROPY_MAX_LENGTH = 4096
_HIGH_ENTROPY_BITS_PER_CHAR_THRESHOLD = 3.0


def _normalize_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.strip().lower())


def is_sensitive_key_name(name: str) -> bool:
    """True if a header/query/body field *name* is deny-listed outright."""
    normalized = _normalize_key(name)
    if not normalized:
        return False
    return any(marker in normalized for marker in _SENSITIVE_KEY_SUBSTRINGS)


def _shannon_entropy_bits_per_char(value: str) -> float:
    if not value:
        return 0.0
    counts: dict[str, int] = {}
    for char in value:
        counts[char] = counts.get(char, 0) + 1
    length = len(value)
    return -sum((count / length) * math.log2(count / length) for count in counts.values())


def looks_like_high_entropy_secret(value: str) -> bool:
    """True for opaque-looking tokens (base64/hex-ish, long, high entropy).

    Deliberately does not require any particular key name -- a token can
    show up under an innocuous-looking key.
    """
    candidate = value.strip()
    length = len(candidate)
    if length < _HIGH_ENTROPY_MIN_LENGTH or length > _HIGH_ENTROPY_MAX_LENGTH:
        return False
    if not _HIGH_ENTROPY_CHARSET_RE.match(candidate):
        return False
    return _shannon_entropy_bits_per_char(candidate) >= _HIGH_ENTROPY_BITS_PER_CHAR_THRESHOLD


def looks_like_pii_value(value: str) -> bool:
    """True for values matching common PII shapes (email/SSN/phone)."""
    candidate = value.strip()
    if not candidate:
        return False
    if _EMAIL_RE.match(candidate):
        return True
    if _SSN_RE.match(candidate):
        return True
    digits = re.sub(r"\D", "", candidate)
    if _PHONE_DIGITS_RE.match(candidate) and len(digits) >= 9:
        return True
    return False


@dataclass(frozen=True)
class FieldDecision:
    """Whether one (name, value) field survives default-deny redaction."""

    keep: bool
    reason: str


def evaluate_field(name: str, value: object) -> FieldDecision:
    """Decide whether ``name`` may be retained (never ``value`` itself)."""
    if is_sensitive_key_name(name):
        return FieldDecision(False, "sensitive_key_name")
    if isinstance(value, str):
        if looks_like_pii_value(value):
            return FieldDecision(False, "pii_value_pattern")
        if looks_like_high_entropy_secret(value):
            return FieldDecision(False, "high_entropy_value")
    return FieldDecision(True, "allowed")


def _normalize_key_name(name: str) -> tuple[str, bool]:
    if len(name) <= MAX_KEY_NAME_LENGTH:
        return name, False
    return name[:MAX_KEY_NAME_LENGTH], True


@dataclass(frozen=True)
class FieldRedactionResult:
    kept_names: tuple[str, ...]
    redacted: bool
    truncated: bool


def redact_field_names(
    fields: Iterable[tuple[str, object]], *, max_fields: int
) -> FieldRedactionResult:
    """Default-deny-filter (name, value) pairs down to a bounded tuple of
    surviving *names only* -- used for query-string pairs and JSON/form body
    top-level items alike.
    """
    allowed: list[str] = []
    redacted = False
    name_truncated = False
    for name, value in fields:
        decision = evaluate_field(str(name), value)
        if not decision.keep:
            redacted = True
            continue
        normalized, was_long = _normalize_key_name(str(name))
        if was_long:
            name_truncated = True
        allowed.append(normalized)
    count_truncated = len(allowed) > max_fields
    kept = tuple(allowed[:max_fields])
    return FieldRedactionResult(
        kept_names=kept,
        redacted=redacted,
        truncated=count_truncated or name_truncated,
    )


def redact_body_mapping(mapping: Mapping[str, object], *, max_fields: int) -> FieldRedactionResult:
    return redact_field_names(mapping.items(), max_fields=max_fields)


# Response header names considered stable/structural enough for endpoint
# inference. Everything else -- including anything not on this allowlist --
# is default-denied, on top of the always-blocked names below.
STABLE_RESPONSE_HEADER_ALLOWLIST = frozenset(
    {
        "content-type",
        "content-length",
        "content-encoding",
        "content-language",
        "cache-control",
        "etag",
        "last-modified",
        "vary",
        "access-control-allow-origin",
        "access-control-allow-credentials",
        "access-control-expose-headers",
        "referrer-policy",
        "x-content-type-options",
        "x-frame-options",
        "location",
        "allow",
    }
)

# Always denied regardless of the allowlist above (defense in depth if a
# name is ever accidentally added to both).
ALWAYS_BLOCKED_HEADER_NAMES = frozenset(
    {
        "cookie",
        "set-cookie",
        "set-cookie2",
        "authorization",
        "proxy-authorization",
        "www-authenticate",
        "x-csrf-token",
        "x-xsrf-token",
        "x-api-key",
        "x-auth-token",
        "x-session-id",
    }
)


def redact_response_header_names(
    header_names: Iterable[str], *, max_headers: int
) -> FieldRedactionResult:
    """Default-deny-filter response header *names* (never values) down to a
    bounded, allowlisted, always-lowercased tuple.
    """
    allowed: list[str] = []
    redacted = False
    for name in header_names:
        lowered = name.strip().lower()
        if lowered in ALWAYS_BLOCKED_HEADER_NAMES or lowered not in STABLE_RESPONSE_HEADER_ALLOWLIST:
            redacted = True
            continue
        allowed.append(lowered)
    truncated = len(allowed) > max_headers
    kept = tuple(allowed[:max_headers])
    return FieldRedactionResult(kept_names=kept, redacted=redacted, truncated=truncated)


__all__ = [
    "ALWAYS_BLOCKED_HEADER_NAMES",
    "STABLE_RESPONSE_HEADER_ALLOWLIST",
    "FieldDecision",
    "FieldRedactionResult",
    "evaluate_field",
    "is_sensitive_key_name",
    "looks_like_high_entropy_secret",
    "looks_like_pii_value",
    "redact_body_mapping",
    "redact_field_names",
    "redact_response_header_names",
]
