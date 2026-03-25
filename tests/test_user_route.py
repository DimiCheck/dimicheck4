import importlib
from pathlib import Path
import sys

import gspread
import pytest
from prometheus_client import REGISTRY

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


class _FakeWorksheet:
    def get_all_records(self):
        return []


class _FakeSpreadsheet:
    def worksheet(self, _name):
        return _FakeWorksheet()


class _FakeGSpreadClient:
    def open_by_url(self, _url):
        return _FakeSpreadsheet()


def _load_app(monkeypatch):
    monkeypatch.setattr(gspread, "service_account", lambda _path: _FakeGSpreadClient())
    for collector in list(REGISTRY._collector_to_names):
        names = REGISTRY._collector_to_names.get(collector, ())
        if any(name.startswith("http_request") or name.startswith("http_requests") for name in names):
            REGISTRY.unregister(collector)
    for module_name in ("app", "config", "utils", "ws", "eventlet"):
        sys.modules.pop(module_name, None)
    app_module = importlib.import_module("app")
    return app_module.app


def test_user_html_route_serves_page(monkeypatch):
    app = _load_app(monkeypatch)
    client = app.test_client()

    response = client.get("/user.html")

    assert response.status_code == 200
    assert "DIMI Check" in response.get_data(as_text=True)


def test_user_alias_redirects_to_user_html(monkeypatch):
    app = _load_app(monkeypatch)
    client = app.test_client()

    response = client.get("/user", follow_redirects=False)

    assert response.status_code == 302
    assert response.headers["Location"].endswith("/user.html")


def test_static_html_pages_are_not_shadowed_by_short_code_route(monkeypatch):
    app = _load_app(monkeypatch)
    client = app.test_client()

    for path in ["/schoollife.html", "/routine.html", "/my.html", "/qrandseats.html"]:
        response = client.get(path)
        assert response.status_code == 200, path


@pytest.fixture
def guarded_app(monkeypatch):
    monkeypatch.setenv("DDOS_GUARD_WINDOW_SECONDS", "60")
    monkeypatch.setenv("DDOS_GUARD_API_VERSION_MAX_REQUESTS", "2")
    monkeypatch.setenv("DDOS_GUARD_METRICS_MAX_REQUESTS", "1")
    app = _load_app(monkeypatch)
    return app


def test_api_version_is_rate_limited_per_client_ip(guarded_app):
    client = guarded_app.test_client()
    headers = {"X-Forwarded-For": "203.0.113.10"}

    assert client.get("/api/version", headers=headers).status_code == 200
    assert client.get("/api/version", headers=headers).status_code == 200

    blocked = client.get("/api/version", headers=headers)
    assert blocked.status_code == 429
    assert blocked.get_json()["error"]["message"] == "too many requests"
    assert 1 <= int(blocked.headers["Retry-After"]) <= 60


def test_metrics_limit_is_isolated_by_client_ip(guarded_app):
    client = guarded_app.test_client()

    first = client.get("/metrics", headers={"X-Forwarded-For": "198.51.100.7"})
    assert first.status_code == 200

    second = client.get("/metrics", headers={"X-Forwarded-For": "198.51.100.7"})
    assert second.status_code == 429

    third = client.get("/metrics", headers={"X-Forwarded-For": "198.51.100.8"})
    assert third.status_code == 200
