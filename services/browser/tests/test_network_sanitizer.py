"""Unit tests for browser_service.network.sanitizer.sanitize_exchange.

Exercises the sanitizer directly against constructed RawExchange records
(no real Chrome needed here -- see test_network_capture.py for real-CDP
correlation coverage) so the full "Validate" checklist from the P03-F01
brief -- synthetic traffic coverage, redaction canaries, size limits,
binary handling, same-origin tagging, zero-secret snapshots -- runs fast.
"""

from __future__ import annotations

import dataclasses
import json

from browser_service.network.observation import InitiatorCategory
from browser_service.network.sanitizer import (
    SanitizerLimits,
    normalize_origin,
    sanitize_exchange,
)
from browser_service.network.sanitizer import RawExchange as _RawExchange

HIGH_ENTROPY_TOKEN = "aZ9kL2mQ7xR4vB8nC1pW6sT3yU0dF5gH"  # noqa: S105 -- synthetic fixture value
FAKE_COOKIE_VALUE = "session_id=deadbeef1234567890abcdef; Path=/"  # noqa: S105
FAKE_AUTH_HEADER_VALUE = "Bearer sk_live_abcdefghijklmnopqrstuvwxyz012345"  # noqa: S105
FAKE_EMAIL = "victim@example.com"


def make_raw(**overrides: object) -> _RawExchange:
    defaults: dict[str, object] = dict(
        request_id="1",
        method="GET",
        url="https://api.example.com/v1/widgets?foo=bar",
        resource_type="XHR",
        initiator_type="script",
        status=200,
        response_content_type="application/json",
        response_header_names=("Content-Type", "Cache-Control"),
        request_timestamp=100.0,
        finished_timestamp=100.25,
        wall_time=1_700_000_000.0,
    )
    defaults.update(overrides)
    return _RawExchange(**defaults)  # type: ignore[arg-type]


def test_get_request_json_response_sanitizes_cleanly() -> None:
    raw = make_raw(
        response_body_text=json.dumps({"id": 1, "name": "widget"}),
    )
    obs = sanitize_exchange(raw, task_id="task-1", session_id="sess-1", page_origin="https://api.example.com")
    assert obs is not None
    assert obs.method == "GET"
    assert obs.origin == "https://api.example.com"
    assert obs.path == "/v1/widgets"
    assert obs.query_keys == ("foo",)
    assert obs.same_origin is True
    assert obs.status == 200
    assert obs.initiator is InitiatorCategory.SCRIPT
    assert obs.response_body_shape is not None
    assert obs.response_body_shape.kind == "object"
    assert set(obs.response_body_shape.keys) == {"id", "name"}
    assert obs.timing_ms == 250.0


def test_post_json_request_body_shape_captured() -> None:
    raw = make_raw(
        method="post",
        request_content_type="application/json",
        request_body_text=json.dumps({"title": "hello", "count": 3}),
        response_body_text=json.dumps({"ok": True}),
    )
    obs = sanitize_exchange(raw, task_id="task-1", session_id=None, page_origin="https://api.example.com")
    assert obs is not None
    assert obs.method == "POST"
    assert obs.request_body_shape is not None
    assert obs.request_body_shape.kind == "object"
    assert set(obs.request_body_shape.keys) == {"title", "count"}


def test_post_form_encoded_request_body_shape_captured() -> None:
    raw = make_raw(
        method="POST",
        request_content_type="application/x-www-form-urlencoded",
        request_body_text="field_one=value_one&field_two=value_two",
        response_body_text=None,
        response_content_type=None,
    )
    obs = sanitize_exchange(raw, task_id="task-1", session_id=None, page_origin="https://api.example.com")
    assert obs is not None
    assert obs.request_body_shape is not None
    assert obs.request_body_shape.kind == "object"
    assert set(obs.request_body_shape.keys) == {"field_one", "field_two"}


def test_array_and_primitive_and_empty_body_shapes() -> None:
    array_obs = sanitize_exchange(
        make_raw(response_body_text=json.dumps([1, 2, 3])),
        task_id="t",
        session_id=None,
        page_origin="https://api.example.com",
    )
    assert array_obs is not None and array_obs.response_body_shape is not None
    assert array_obs.response_body_shape.kind == "array"
    assert array_obs.response_body_shape.keys == ()

    primitive_obs = sanitize_exchange(
        make_raw(response_body_text=json.dumps("just a string")),
        task_id="t",
        session_id=None,
        page_origin="https://api.example.com",
    )
    assert primitive_obs is not None and primitive_obs.response_body_shape is not None
    assert primitive_obs.response_body_shape.kind == "primitive"

    empty_obs = sanitize_exchange(
        make_raw(response_body_text=None),
        task_id="t",
        session_id=None,
        page_origin="https://api.example.com",
    )
    assert empty_obs is not None and empty_obs.response_body_shape is not None
    assert empty_obs.response_body_shape.kind == "empty"


def test_unparseable_body_becomes_primitive_shape_not_discarded() -> None:
    obs = sanitize_exchange(
        make_raw(response_body_text="not-json-and-not-form{{{"),
        task_id="t",
        session_id=None,
        page_origin="https://api.example.com",
    )
    assert obs is not None
    assert obs.response_body_shape is not None
    assert obs.response_body_shape.kind == "primitive"


def test_non_xhr_fetch_resource_type_discarded() -> None:
    for resource_type in ["Document", "Script", "Stylesheet", "Image", "Media", "Font", "WebSocket", "Ping"]:
        obs = sanitize_exchange(
            make_raw(resource_type=resource_type),
            task_id="t",
            session_id=None,
            page_origin="https://api.example.com",
        )
        assert obs is None, f"resource_type={resource_type} should be discarded, not partially recorded"


def test_binary_content_type_response_discarded_entirely() -> None:
    for content_type in ["image/png", "font/woff2", "audio/mpeg", "video/mp4", "application/octet-stream"]:
        obs = sanitize_exchange(
            make_raw(response_content_type=content_type, response_body_text="binary-ish-bytes-not-decoded"),
            task_id="t",
            session_id=None,
            page_origin="https://api.example.com",
        )
        assert obs is None, f"content_type={content_type} should be discarded entirely"


def test_text_and_json_content_types_are_not_discarded() -> None:
    for content_type in ["application/json", "application/json; charset=utf-8", "text/plain", "application/xml"]:
        obs = sanitize_exchange(
            make_raw(response_content_type=content_type, response_body_text=None),
            task_id="t",
            session_id=None,
            page_origin="https://api.example.com",
        )
        assert obs is not None


def test_same_origin_true_for_matching_origin() -> None:
    obs = sanitize_exchange(
        make_raw(url="https://api.example.com/v1/x"),
        task_id="t",
        session_id=None,
        page_origin="https://api.example.com",
    )
    assert obs is not None
    assert obs.same_origin is True


def test_same_origin_false_for_cross_origin_host() -> None:
    obs = sanitize_exchange(
        make_raw(url="https://other.example.com/v1/x"),
        task_id="t",
        session_id=None,
        page_origin="https://api.example.com",
    )
    assert obs is not None
    assert obs.same_origin is False


def test_same_origin_false_for_different_scheme_or_port() -> None:
    http_obs = sanitize_exchange(
        make_raw(url="http://api.example.com/v1/x"),
        task_id="t",
        session_id=None,
        page_origin="https://api.example.com",
    )
    assert http_obs is not None
    assert http_obs.same_origin is False

    port_obs = sanitize_exchange(
        make_raw(url="https://api.example.com:8443/v1/x"),
        task_id="t",
        session_id=None,
        page_origin="https://api.example.com",
    )
    assert port_obs is not None
    assert port_obs.same_origin is False


def test_same_origin_false_when_page_origin_unknown() -> None:
    obs = sanitize_exchange(
        make_raw(url="https://api.example.com/v1/x"),
        task_id="t",
        session_id=None,
        page_origin=None,
    )
    assert obs is not None
    assert obs.same_origin is False


def test_normalize_origin_default_ports_and_lowercasing() -> None:
    assert normalize_origin("HTTPS://API.Example.com:443/path") == "https://api.example.com"
    assert normalize_origin("http://Example.com:80/path") == "http://example.com"
    assert normalize_origin("https://example.com:8443/path") == "https://example.com:8443"
    assert normalize_origin("about:blank") is None


def test_size_limits_truncate_oversized_body() -> None:
    limits = SanitizerLimits(max_body_sample_bytes=50)
    huge_value = "x" * 1000
    raw = make_raw(response_body_text=json.dumps({"blob": huge_value}))
    obs = sanitize_exchange(raw, task_id="t", session_id=None, page_origin="https://api.example.com", limits=limits)
    assert obs is not None
    assert obs.truncated is True


def test_size_limits_cap_query_key_count() -> None:
    limits = SanitizerLimits(max_query_keys=2)
    query = "&".join(f"k{i}=v{i}" for i in range(10))
    raw = make_raw(url=f"https://api.example.com/v1/x?{query}")
    obs = sanitize_exchange(raw, task_id="t", session_id=None, page_origin="https://api.example.com", limits=limits)
    assert obs is not None
    assert len(obs.query_keys) == 2
    assert obs.truncated is True


def test_size_limits_cap_body_key_count() -> None:
    limits = SanitizerLimits(max_body_keys=3)
    body = {f"field{i}": "v" for i in range(10)}
    raw = make_raw(response_body_text=json.dumps(body))
    obs = sanitize_exchange(raw, task_id="t", session_id=None, page_origin="https://api.example.com", limits=limits)
    assert obs is not None
    assert obs.response_body_shape is not None
    assert len(obs.response_body_shape.keys) == 3
    assert obs.truncated is True


def test_size_limits_cap_response_header_count() -> None:
    limits = SanitizerLimits(max_response_headers=1)
    raw = make_raw(response_header_names=("Content-Type", "Cache-Control", "Vary", "Etag"))
    obs = sanitize_exchange(raw, task_id="t", session_id=None, page_origin="https://api.example.com", limits=limits)
    assert obs is not None
    assert len(obs.stable_response_headers) == 1
    assert obs.truncated is True


# --- Redaction canaries -----------------------------------------------------


def test_redaction_canary_cookie_and_auth_headers_never_retained() -> None:
    raw = make_raw(
        response_header_names=("Content-Type", "Set-Cookie", "Authorization"),
    )
    obs = sanitize_exchange(raw, task_id="t", session_id=None, page_origin="https://api.example.com")
    assert obs is not None
    assert "set-cookie" not in obs.stable_response_headers
    assert "authorization" not in obs.stable_response_headers
    assert obs.redacted is True
    serialized = repr(obs)
    assert FAKE_COOKIE_VALUE not in serialized
    assert FAKE_AUTH_HEADER_VALUE not in serialized


def test_redaction_canary_secret_and_pii_body_fields_never_retained() -> None:
    body = {
        "username": "alice",
        "password": "hunter2-super-secret",
        "email": FAKE_EMAIL,
        "auth_token": HIGH_ENTROPY_TOKEN,
        "csrf_token": "abc123csrf",
        "note": "hello world",
    }
    raw = make_raw(response_body_text=json.dumps(body))
    obs = sanitize_exchange(raw, task_id="t", session_id=None, page_origin="https://api.example.com")
    assert obs is not None
    assert obs.response_body_shape is not None
    kept = set(obs.response_body_shape.keys)
    assert kept == {"username", "note"}
    assert obs.redacted is True

    serialized = repr(obs)
    for secret in ["hunter2-super-secret", FAKE_EMAIL, HIGH_ENTROPY_TOKEN, "abc123csrf"]:
        assert secret not in serialized


def test_redaction_canary_high_entropy_query_value_drops_key_entirely() -> None:
    raw = make_raw(
        url=f"https://api.example.com/v1/x?session={HIGH_ENTROPY_TOKEN}&page=2",
    )
    obs = sanitize_exchange(raw, task_id="t", session_id=None, page_origin="https://api.example.com")
    assert obs is not None
    assert "session" not in obs.query_keys
    assert "page" in obs.query_keys
    assert HIGH_ENTROPY_TOKEN not in repr(obs)
    assert obs.redacted is True


def test_zero_secret_snapshot_across_full_exchange() -> None:
    secrets = [
        FAKE_COOKIE_VALUE,
        FAKE_AUTH_HEADER_VALUE,
        FAKE_EMAIL,
        HIGH_ENTROPY_TOKEN,
        "123-45-6789",  # fake SSN
        "hunter2-super-secret",
    ]
    raw = make_raw(
        url=(
            "https://api.example.com/v1/widgets"
            f"?session_token={HIGH_ENTROPY_TOKEN}&user_email={FAKE_EMAIL}&page=1"
        ),
        response_header_names=("Content-Type", "Set-Cookie", "Authorization"),
        request_content_type="application/json",
        request_body_text=json.dumps(
            {
                "password": "hunter2-super-secret",
                "ssn": "123-45-6789",
                "note": "ok",
            }
        ),
        response_body_text=json.dumps(
            {
                "auth": FAKE_AUTH_HEADER_VALUE,
                "cookie": FAKE_COOKIE_VALUE,
                "status": "ok",
            }
        ),
    )
    obs = sanitize_exchange(raw, task_id="t", session_id="s", page_origin="https://api.example.com")
    assert obs is not None
    assert obs.redacted is True

    serialized = json.dumps(_observation_to_jsonable(obs))
    for secret in secrets:
        assert secret not in serialized, f"leaked secret substring: {secret!r}"


def _observation_to_jsonable(obs: object) -> object:
    def default(value: object) -> object:
        if dataclasses.is_dataclass(value) and not isinstance(value, type):
            return dataclasses.asdict(value)
        if hasattr(value, "value"):  # Enum
            return value.value
        return str(value)

    return json.loads(json.dumps(dataclasses.asdict(obs), default=default))  # type: ignore[arg-type]
