from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path
from typing import Any

import pytest
import yaml
from pydantic import ValidationError

from browser_service.sites.loader import (
    SitePolicyLoadError,
    SitePolicyLoader,
    default_sites_root,
    parse_site_policy_file,
)
from browser_service.sites.schema import Decision, SitePolicy
from scripts.lint_site_policies import lint


def base_policy_fields(**overrides: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "schema_version": 1,
        "site_id": "test-site",
        "canonical_domain": "example.com",
        "allowed_subdomains": ["api", "*.static"],
        "allowed_routes": ["/v1/users", "/v1/items/*"],
        "allowed_methods": ["GET", "HEAD"],
        "discovery_permitted": True,
        "replay_permitted": True,
        "data_classification": "internal",
        "retention_days": 30,
        "owner": "Test Owner",
        "reviewer": "Test Reviewer",
        "decision": "approved",
        "decision_date": "2026-08-01",
        "review_date": "2026-08-01",
        "kill_switch_enabled": False,
    }
    fields.update(overrides)
    return fields


def write_site_yaml(directory: Path, filename_stem: str, fields: dict[str, Any]) -> Path:
    path = directory / f"{filename_stem}.yaml"
    path.write_text(yaml.safe_dump(fields, sort_keys=False), encoding="utf-8")
    return path


# --- schema.py -------------------------------------------------------------


def test_valid_record_parses_and_normalizes_domain_case() -> None:
    policy = SitePolicy.model_validate(
        base_policy_fields(canonical_domain="Example.COM", allowed_subdomains=["API", "*.Static"])
    )
    assert policy.canonical_domain == "example.com"
    assert policy.allowed_subdomains == ["api", "*.static"]
    assert policy.decision is Decision.APPROVED


def test_idn_domain_normalizes_to_punycode() -> None:
    policy = SitePolicy.model_validate(base_policy_fields(canonical_domain="münchen.example"))
    assert policy.canonical_domain == "xn--mnchen-3ya.example"


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE", "post", "TRACE"])
def test_unsafe_methods_rejected_outright(method: str) -> None:
    with pytest.raises(ValidationError, match="unsafe_method_not_permitted_this_phase"):
        SitePolicy.model_validate(base_policy_fields(allowed_methods=["GET", method]))


def test_empty_allowed_methods_rejected() -> None:
    with pytest.raises(ValidationError, match="allowed_methods_empty"):
        SitePolicy.model_validate(base_policy_fields(allowed_methods=[]))


@pytest.mark.parametrize("wildcard", ["*", "**"])
def test_bare_or_double_star_subdomain_wildcard_rejected(wildcard: str) -> None:
    with pytest.raises(ValidationError, match="wildcard"):
        SitePolicy.model_validate(base_policy_fields(allowed_subdomains=[wildcard]))


def test_unbounded_subdomain_wildcard_rejected() -> None:
    with pytest.raises(ValidationError, match="unbounded_subdomain_wildcard"):
        SitePolicy.model_validate(base_policy_fields(allowed_subdomains=["api.*.example"]))


@pytest.mark.parametrize("wildcard", ["*", "/*"])
def test_bare_route_wildcard_rejected(wildcard: str) -> None:
    with pytest.raises(ValidationError, match="overly_broad_route_wildcard"):
        SitePolicy.model_validate(base_policy_fields(allowed_routes=[wildcard]))


def test_double_star_route_wildcard_rejected() -> None:
    with pytest.raises(ValidationError, match="unbounded_route_wildcard"):
        SitePolicy.model_validate(base_policy_fields(allowed_routes=["/v1/**"]))


def test_bounded_wildcards_accepted_and_normalized() -> None:
    policy = SitePolicy.model_validate(
        base_policy_fields(
            allowed_subdomains=["*.STATIC"],
            allowed_routes=["/v1/items/*"],
        )
    )
    assert policy.allowed_subdomains == ["*.static"]
    assert policy.allowed_routes == ["/v1/items/*"]


def test_approved_requires_reviewer() -> None:
    with pytest.raises(ValidationError, match="approved_decision_requires_reviewer"):
        SitePolicy.model_validate(base_policy_fields(reviewer=None))


def test_approved_requires_decision_date() -> None:
    with pytest.raises(ValidationError, match="approved_decision_requires_decision_date"):
        SitePolicy.model_validate(base_policy_fields(decision_date=None))


def test_pending_decision_does_not_require_reviewer_or_decision_date() -> None:
    policy = SitePolicy.model_validate(
        base_policy_fields(decision="pending", reviewer=None, decision_date=None)
    )
    assert policy.decision is Decision.PENDING


def test_future_decision_date_rejected() -> None:
    future = (date.today() + timedelta(days=5)).isoformat()
    with pytest.raises(ValidationError, match="invalid_date_in_future"):
        SitePolicy.model_validate(base_policy_fields(decision_date=future))


def test_too_old_decision_date_rejected() -> None:
    with pytest.raises(ValidationError, match="invalid_date_too_old"):
        SitePolicy.model_validate(base_policy_fields(decision_date="1999-01-01"))


def test_credential_shaped_value_rejected() -> None:
    with pytest.raises(ValidationError):
        SitePolicy.model_validate(
            base_policy_fields(owner="sk-abcdefghijklmnopqrstuvwxyz012345")
        )


def test_wrong_schema_version_rejected() -> None:
    with pytest.raises(ValidationError, match="unsupported_schema_version"):
        SitePolicy.model_validate(base_policy_fields(schema_version=2))


def test_route_and_method_allowed_exact_match() -> None:
    policy = SitePolicy.model_validate(base_policy_fields())
    assert policy.route_and_method_allowed("GET", "/v1/users") is True
    assert policy.route_and_method_allowed("HEAD", "/v1/users") is True
    assert policy.route_and_method_allowed("GET", "/v1/users/extra") is False


def test_route_and_method_allowed_bounded_wildcard() -> None:
    policy = SitePolicy.model_validate(base_policy_fields())
    assert policy.route_and_method_allowed("GET", "/v1/items/42") is True
    assert policy.route_and_method_allowed("GET", "/v1/items/") is False
    assert policy.route_and_method_allowed("GET", "/v1/items/42/sub") is False
    assert policy.route_and_method_allowed("GET", "/v1/items") is False


def test_route_and_method_allowed_rejects_non_safe_method_even_if_requested() -> None:
    policy = SitePolicy.model_validate(base_policy_fields())
    assert policy.route_and_method_allowed("POST", "/v1/users") is False
    assert policy.route_and_method_allowed("DELETE", "/v1/items/42") is False


# --- loader.py ---------------------------------------------------------


def test_parse_committed_local_fixture_policy() -> None:
    policy = parse_site_policy_file(default_sites_root() / "local-fixture.yaml")
    assert policy.site_id == "local-fixture"
    assert policy.canonical_domain == "localhost"
    assert policy.decision is Decision.APPROVED
    assert policy.allowed_methods == ["GET", "HEAD"]


def test_loader_approved_site_allows_capture_and_replay(tmp_path: Path) -> None:
    write_site_yaml(tmp_path, "test-site", base_policy_fields())
    loader = SitePolicyLoader(root=tmp_path)
    assert loader.is_capture_allowed("test-site") is True
    assert loader.is_replay_allowed("test-site", "GET", "/v1/users") is True
    assert loader.is_replay_allowed("test-site", "HEAD", "/v1/items/42") is True


def test_loader_unknown_site_blocked(tmp_path: Path) -> None:
    write_site_yaml(tmp_path, "test-site", base_policy_fields())
    loader = SitePolicyLoader(root=tmp_path)
    assert loader.is_capture_allowed("nonexistent") is False
    assert loader.is_replay_allowed("nonexistent", "GET", "/v1/users") is False
    assert loader.get_policy("nonexistent") is None


@pytest.mark.parametrize("decision", ["pending", "rejected"])
def test_loader_missing_approval_blocks_capture_and_replay(tmp_path: Path, decision: str) -> None:
    write_site_yaml(
        tmp_path,
        "test-site",
        base_policy_fields(decision=decision, reviewer=None, decision_date=None),
    )
    loader = SitePolicyLoader(root=tmp_path)
    assert loader.is_capture_allowed("test-site") is False
    assert loader.is_replay_allowed("test-site", "GET", "/v1/users") is False


def test_loader_kill_switch_blocks_even_when_approved(tmp_path: Path) -> None:
    write_site_yaml(tmp_path, "test-site", base_policy_fields(kill_switch_enabled=True))
    loader = SitePolicyLoader(root=tmp_path)
    assert loader.is_capture_allowed("test-site") is False
    assert loader.is_replay_allowed("test-site", "GET", "/v1/users") is False


def test_loader_expired_approval_blocks(tmp_path: Path) -> None:
    write_site_yaml(
        tmp_path,
        "test-site",
        base_policy_fields(decision_date="2024-01-01", review_date="2024-01-01"),
    )
    loader = SitePolicyLoader(
        root=tmp_path,
        approval_staleness_days=365,
        today_fn=lambda: date(2026, 1, 1),
    )
    assert loader.is_capture_allowed("test-site") is False
    assert loader.is_replay_allowed("test-site", "GET", "/v1/users") is False


def test_loader_replay_rejects_unsafe_method_even_if_present(tmp_path: Path) -> None:
    write_site_yaml(tmp_path, "test-site", base_policy_fields())
    loader = SitePolicyLoader(root=tmp_path)
    assert loader.is_replay_allowed("test-site", "POST", "/v1/users") is False
    assert loader.is_replay_allowed("test-site", "DELETE", "/v1/items/42") is False


def test_loader_replay_rejects_unlisted_route(tmp_path: Path) -> None:
    write_site_yaml(tmp_path, "test-site", base_policy_fields())
    loader = SitePolicyLoader(root=tmp_path)
    assert loader.is_replay_allowed("test-site", "GET", "/v2/unknown") is False


def test_loader_ttl_cache_avoids_rereading_until_expiry(tmp_path: Path) -> None:
    write_site_yaml(tmp_path, "test-site", base_policy_fields())
    fake_time = {"now": 0.0}
    loader = SitePolicyLoader(root=tmp_path, ttl_seconds=10.0, clock=lambda: fake_time["now"])

    assert loader.is_capture_allowed("test-site") is True

    write_site_yaml(tmp_path, "test-site", base_policy_fields(discovery_permitted=False))
    fake_time["now"] = 5.0
    assert loader.is_capture_allowed("test-site") is True

    fake_time["now"] = 11.0
    assert loader.is_capture_allowed("test-site") is False


def test_loader_duplicate_site_id_raises(tmp_path: Path) -> None:
    write_site_yaml(tmp_path, "site-a", base_policy_fields(site_id="dup-site"))
    write_site_yaml(tmp_path, "site-b", base_policy_fields(site_id="dup-site"))
    loader = SitePolicyLoader(root=tmp_path)
    with pytest.raises(SitePolicyLoadError, match="duplicate_site_id"):
        loader.get_policy("dup-site")


def test_loader_filename_site_id_mismatch_raises(tmp_path: Path) -> None:
    write_site_yaml(tmp_path, "wrong-name", base_policy_fields(site_id="test-site"))
    loader = SitePolicyLoader(root=tmp_path)
    with pytest.raises(SitePolicyLoadError, match="site_id_filename_mismatch"):
        loader.get_policy("test-site")


def test_loader_invalid_yaml_raises(tmp_path: Path) -> None:
    path = tmp_path / "broken.yaml"
    path.write_text("site_id: [unclosed", encoding="utf-8")
    loader = SitePolicyLoader(root=tmp_path)
    with pytest.raises(SitePolicyLoadError, match="invalid_yaml"):
        loader.get_policy("broken")


def test_loader_credential_shaped_key_raises(tmp_path: Path) -> None:
    fields = base_policy_fields()
    fields["api_key"] = "some-value"
    write_site_yaml(tmp_path, "test-site", fields)
    loader = SitePolicyLoader(root=tmp_path)
    with pytest.raises(SitePolicyLoadError, match="credential_shaped_key_found"):
        loader.get_policy("test-site")


def test_loader_missing_root_directory_yields_no_policies(tmp_path: Path) -> None:
    loader = SitePolicyLoader(root=tmp_path / "does-not-exist")
    assert loader.get_policy("anything") is None
    assert loader.is_capture_allowed("anything") is False


# --- scripts/lint_site_policies.py --------------------------------------


def test_lint_passes_on_committed_config(capsys: pytest.CaptureFixture[str]) -> None:
    assert lint(default_sites_root()) == 0


def test_lint_returns_zero_and_warns_on_empty_directory(tmp_path: Path) -> None:
    assert lint(tmp_path) == 0


def test_lint_returns_nonzero_on_missing_directory(tmp_path: Path) -> None:
    assert lint(tmp_path / "missing") == 1


def test_lint_rejects_duplicate_site_id(tmp_path: Path) -> None:
    write_site_yaml(tmp_path, "site-a", base_policy_fields(site_id="dup-site"))
    write_site_yaml(tmp_path, "site-b", base_policy_fields(site_id="dup-site"))
    assert lint(tmp_path) == 1


def test_lint_rejects_overly_broad_wildcard(tmp_path: Path) -> None:
    write_site_yaml(tmp_path, "test-site", base_policy_fields(allowed_routes=["/*"]))
    assert lint(tmp_path) == 1


def test_lint_rejects_unsafe_method(tmp_path: Path) -> None:
    write_site_yaml(tmp_path, "test-site", base_policy_fields(allowed_methods=["GET", "POST"]))
    assert lint(tmp_path) == 1


def test_lint_rejects_invalid_date(tmp_path: Path) -> None:
    write_site_yaml(tmp_path, "test-site", base_policy_fields(decision_date="1900-01-01"))
    assert lint(tmp_path) == 1


def test_lint_rejects_credential_shaped_value(tmp_path: Path) -> None:
    write_site_yaml(
        tmp_path,
        "test-site",
        base_policy_fields(owner="ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
    )
    assert lint(tmp_path) == 1


def test_lint_accepts_valid_single_site(tmp_path: Path) -> None:
    write_site_yaml(tmp_path, "test-site", base_policy_fields())
    assert lint(tmp_path) == 0
