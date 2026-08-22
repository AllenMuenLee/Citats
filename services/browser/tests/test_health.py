"""Tests for the liveness/readiness health endpoints.

These are Phase 0 scaffolding tests: they confirm the endpoints exist,
return the documented shape, and never leak connection details -- they do
not (and, at this phase, cannot) assert real Postgres/Redis behavior.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from browser_service.app import app

client = TestClient(app)


def test_health_live_returns_ok_shape() -> None:
    response = client.get("/health/live")
    assert response.status_code == 200
    assert response.json() == {"status": "live"}


def test_health_ready_returns_structured_component_states(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # No Postgres/Redis env vars configured -> both components "unknown",
    # overall status "not_ready", and nothing resembling a connection
    # string/host/password anywhere in the body.
    monkeypatch.delenv("POSTGRES_HOST", raising=False)
    monkeypatch.delenv("POSTGRES_PORT", raising=False)
    monkeypatch.delenv("REDIS_HOST", raising=False)
    monkeypatch.delenv("REDIS_PORT", raising=False)
    monkeypatch.setenv("BROWSER_SERVICE_TOKEN", "test-token-123")

    response = client.get("/health/ready", headers={"X-Service-Token": "test-token-123"})
    assert response.status_code == 200

    body = response.json()
    assert body["status"] == "not_ready"
    assert body["components"] == {"postgres": "unknown", "redis": "unknown"}


def test_health_ready_reports_down_when_unreachable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Point at a port that should not have anything listening.
    monkeypatch.setenv("POSTGRES_HOST", "127.0.0.1")
    monkeypatch.setenv("POSTGRES_PORT", "1")
    monkeypatch.setenv("REDIS_HOST", "127.0.0.1")
    monkeypatch.setenv("REDIS_PORT", "1")
    monkeypatch.setenv("BROWSER_SERVICE_TOKEN", "test-token-123")

    response = client.get("/health/ready", headers={"X-Service-Token": "test-token-123"})
    body = response.json()

    assert body["status"] == "not_ready"
    assert body["components"]["postgres"] == "down"
    assert body["components"]["redis"] == "down"

    # No secrets, hostnames, or connection strings should appear in the body.
    body_text = str(body)
    assert "127.0.0.1" not in body_text
    assert "PASSWORD" not in body_text.upper()


def test_health_ready_requires_token_header(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BROWSER_SERVICE_TOKEN", "test-token-123")

    response = client.get("/health/ready")

    assert response.status_code == 401
    # No body detail should leak the expected token or hint at its value.
    assert "test-token-123" not in response.text


def test_health_ready_rejects_wrong_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BROWSER_SERVICE_TOKEN", "test-token-123")

    response = client.get("/health/ready", headers={"X-Service-Token": "wrong-token"})

    assert response.status_code == 401
    assert "test-token-123" not in response.text


def test_health_ready_rejects_when_service_unconfigured(monkeypatch: pytest.MonkeyPatch) -> None:
    # If BROWSER_SERVICE_TOKEN was never set, the service must refuse every
    # authenticated request rather than falling open.
    monkeypatch.delenv("BROWSER_SERVICE_TOKEN", raising=False)

    response = client.get("/health/ready", headers={"X-Service-Token": "anything"})

    assert response.status_code == 401


def test_health_ready_accepts_correct_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BROWSER_SERVICE_TOKEN", "test-token-123")
    monkeypatch.delenv("POSTGRES_HOST", raising=False)
    monkeypatch.delenv("REDIS_HOST", raising=False)

    response = client.get("/health/ready", headers={"X-Service-Token": "test-token-123"})

    assert response.status_code == 200


def test_health_live_does_not_require_token() -> None:
    # /health/live is a deliberately unauthenticated pure liveness probe.
    response = client.get("/health/live")
    assert response.status_code == 200
