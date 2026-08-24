"""Unit tests for the default-deny redactor (browser_service.network.redactor)."""

from __future__ import annotations

from browser_service.network.redactor import (
    ALWAYS_BLOCKED_HEADER_NAMES,
    STABLE_RESPONSE_HEADER_ALLOWLIST,
    evaluate_field,
    is_sensitive_key_name,
    looks_like_high_entropy_secret,
    looks_like_pii_value,
    redact_body_mapping,
    redact_field_names,
    redact_response_header_names,
)

HIGH_ENTROPY_TOKEN = "aZ9kL2mQ7xR4vB8nC1pW6sT3yU0dF5gH"  # noqa: S105 -- synthetic fixture value


def test_sensitive_key_names_detected_case_and_shape_insensitively() -> None:
    for name in [
        "Authorization",
        "authorization",
        "AUTHORIZATION",
        "Cookie",
        "set-cookie",
        "X-CSRF-Token",
        "csrf_token",
        "api_key",
        "apiKey",
        "password",
        "user_password",
        "ssn",
        "social_security_number",
        "email",
        "user_email_address",
        "phone_number",
        "credit_card_number",
    ]:
        assert is_sensitive_key_name(name), f"expected {name!r} to be flagged sensitive"


def test_benign_key_names_not_flagged() -> None:
    for name in ["method", "status", "limit", "page", "sort", "cursor", "id", "count"]:
        assert not is_sensitive_key_name(name)


def test_high_entropy_secret_detection() -> None:
    assert looks_like_high_entropy_secret(HIGH_ENTROPY_TOKEN)
    assert looks_like_high_entropy_secret("4f9c2a1e8b7d6035f1a2c3d4e5f60718")  # hex-ish blob
    assert not looks_like_high_entropy_secret("hello")
    assert not looks_like_high_entropy_secret("short")
    assert not looks_like_high_entropy_secret("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")  # low entropy, repeated
    assert not looks_like_high_entropy_secret("this is a normal english sentence value")


def test_pii_value_detection() -> None:
    assert looks_like_pii_value("someone@example.com")
    assert looks_like_pii_value("123-45-6789")
    assert looks_like_pii_value("+1 (555) 123-4567")
    assert not looks_like_pii_value("hello world")
    assert not looks_like_pii_value("42")


def test_evaluate_field_denies_sensitive_name_regardless_of_value() -> None:
    decision = evaluate_field("authorization", "totally benign looking value")
    assert decision.keep is False
    assert decision.reason == "sensitive_key_name"


def test_evaluate_field_denies_high_entropy_value_under_innocuous_name() -> None:
    decision = evaluate_field("sid", HIGH_ENTROPY_TOKEN)
    assert decision.keep is False
    assert decision.reason == "high_entropy_value"


def test_evaluate_field_denies_pii_value_under_innocuous_name() -> None:
    decision = evaluate_field("contact", "someone@example.com")
    assert decision.keep is False
    assert decision.reason == "pii_value_pattern"


def test_evaluate_field_allows_benign_field() -> None:
    decision = evaluate_field("page", "2")
    assert decision.keep is True
    assert decision.reason == "allowed"


def test_redact_field_names_drops_sensitive_and_caps_count() -> None:
    fields = [(f"key{i}", "value") for i in range(5)]
    fields.append(("authorization", "Bearer abc"))
    result = redact_field_names(fields, max_fields=3)
    assert "authorization" not in result.kept_names
    assert result.redacted is True
    assert len(result.kept_names) == 3
    assert result.truncated is True


def test_redact_field_names_no_truncation_when_under_cap() -> None:
    fields = [("page", "1"), ("limit", "10")]
    result = redact_field_names(fields, max_fields=10)
    assert result.kept_names == ("page", "limit")
    assert result.redacted is False
    assert result.truncated is False


def test_redact_body_mapping_drops_pii_and_secret_fields() -> None:
    mapping = {
        "username": "alice",
        "password": "hunter2",
        "email": "alice@example.com",
        "session_token": HIGH_ENTROPY_TOKEN,
        "note": "hello",
    }
    result = redact_body_mapping(mapping, max_fields=50)
    assert set(result.kept_names) == {"username", "note"}
    assert result.redacted is True
    assert result.truncated is False


def test_redact_response_header_names_blocks_cookies_and_auth() -> None:
    headers = ["Content-Type", "Set-Cookie", "Authorization", "X-Csrf-Token", "Cache-Control"]
    result = redact_response_header_names(headers, max_headers=10)
    assert result.kept_names == ("content-type", "cache-control")
    assert result.redacted is True
    assert "set-cookie" not in result.kept_names
    assert "authorization" not in result.kept_names


def test_response_header_allowlist_and_blocklist_disjoint() -> None:
    assert STABLE_RESPONSE_HEADER_ALLOWLIST.isdisjoint(ALWAYS_BLOCKED_HEADER_NAMES)


def test_redact_response_header_names_caps_count() -> None:
    headers = list(STABLE_RESPONSE_HEADER_ALLOWLIST)
    result = redact_response_header_names(headers, max_headers=2)
    assert len(result.kept_names) == 2
    assert result.truncated is True


def test_long_key_name_is_truncated_not_dropped() -> None:
    long_name = "a" * 500
    result = redact_field_names([(long_name, "value")], max_fields=10)
    assert len(result.kept_names) == 1
    assert len(result.kept_names[0]) <= 128
    assert result.truncated is True
    assert result.redacted is False
