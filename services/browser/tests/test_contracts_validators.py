"""Unit tests for the hand-written validation helpers in
`browser_service.contracts._validators`, mirroring
`packages/contracts/tests/credential-guard.test.ts` on the TypeScript side.
"""

from __future__ import annotations

import pytest

from browser_service.contracts._validators import (
    ForbiddenCredentialFieldError,
    assert_no_forbidden_fields,
    find_forbidden_field_paths,
    is_http_or_https_url,
)


def test_no_matches_for_benign_nested_object() -> None:
    value = {
        "message": "hi",
        "context": {"locale": "en-US", "nested": {"theme": "dark"}},
        "credentialHandle": "vault:acct:123",
    }
    assert find_forbidden_field_paths(value) == []


@pytest.mark.parametrize(
    "key,value",
    [
        ("cookie", {"cookie": "session=abc"}),
        ("Cookie", {"Cookie": "session=abc"}),
        ("authorization", {"authorization": "Bearer xyz"}),
        ("Authorization", {"Authorization": "Bearer xyz"}),
        ("auth_token", {"auth_token": "xyz"}),
        ("auth-token", {"auth-token": "xyz"}),
        ("authtoken", {"authtoken": "xyz"}),
        ("set-cookie", {"set-cookie": "a=b"}),
        ("headers", {"headers": {"x-foo": "bar"}}),
    ],
)
def test_flags_top_level_forbidden_key(key: str, value: dict[str, object]) -> None:
    matches = find_forbidden_field_paths(value)
    assert key in {m.key for m in matches}


def test_finds_forbidden_key_nested_one_level_deep() -> None:
    value = {"arguments": {"message": "hi", "context": {"cookie": "session=abc123"}}}
    matches = find_forbidden_field_paths(value)
    assert len(matches) == 1
    assert matches[0].path == "arguments.context.cookie"


def test_finds_forbidden_key_nested_arbitrarily_deep_including_in_lists() -> None:
    value = {"a": [{"b": {"c": [{"d": {"authorization": "Bearer xyz"}}]}}]}
    matches = find_forbidden_field_paths(value)
    assert len(matches) == 1
    assert matches[0].path == "a[0].b.c[0].d.authorization"


def test_finds_multiple_forbidden_keys_and_reports_every_path() -> None:
    value = {"cookie": "a", "nested": {"headers": {"authorization": "b"}}}
    matches = find_forbidden_field_paths(value)
    paths = sorted(m.path for m in matches)
    assert paths == sorted(["cookie", "nested.headers", "nested.headers.authorization"])


def test_does_not_flag_legitimate_credential_handle_field() -> None:
    assert find_forbidden_field_paths({"credentialHandle": "vault:acct:123"}) == []


def test_does_not_flag_substrings_anchored_match_only() -> None:
    assert find_forbidden_field_paths({"cookieConsentGiven": True}) == []
    assert find_forbidden_field_paths({"myAuthorizationNote": "x"}) == []


def test_is_safe_against_cyclic_references() -> None:
    value: dict[str, object] = {"message": "hi"}
    value["self"] = value
    # Must not raise (RecursionError, etc.)
    find_forbidden_field_paths(value)


@pytest.mark.parametrize("value", ["just a string", 42, None, True])
def test_ignores_non_container_values(value: object) -> None:
    assert find_forbidden_field_paths(value) == []


def test_assert_no_forbidden_fields_does_not_raise_for_clean_payload() -> None:
    assert_no_forbidden_fields({"message": "hi"})


def test_assert_no_forbidden_fields_raises_with_offending_paths() -> None:
    with pytest.raises(ForbiddenCredentialFieldError) as exc_info:
        assert_no_forbidden_fields({"context": {"cookie": "x"}})
    assert exc_info.value.matches[0].path == "context.cookie"


@pytest.mark.parametrize(
    "value,expected",
    [
        ("https://example.com/a", True),
        ("http://example.com/a", True),
        ("javascript:alert(1)", False),
        ("ftp://example.com/file", False),
        ("not a url", False),
        ("", False),
    ],
)
def test_is_http_or_https_url(value: str, expected: bool) -> None:
    assert is_http_or_https_url(value) is expected
