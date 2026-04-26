import importlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys

import gspread
import pytest
import requests
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


def test_public_static_handler_blocks_sensitive_files(monkeypatch):
    app = _load_app(monkeypatch)
    client = app.test_client()

    assert client.get("/app.py").status_code == 404
    assert client.get("/config.py").status_code == 404
    assert client.get("/app.db").status_code == 404


def test_public_static_handler_keeps_frontend_assets_available(monkeypatch):
    app = _load_app(monkeypatch)
    client = app.test_client()

    assert client.get("/main.css").status_code == 200
    assert client.get("/js/pwa.js").status_code == 200
    assert client.get("/manifest.webmanifest").status_code == 200


def test_schoollife_meal_offset_returns_tomorrows_menu(monkeypatch):
    app = _load_app(monkeypatch)
    client = app.test_client()
    calls = []

    class _FakeMealResponse:
        def __init__(self, date_text):
            self._date_text = date_text

        def raise_for_status(self):
            return None

        def json(self):
            return {
                "date": self._date_text,
                "data": {
                    "breakfast": {"regular": ["아침 메뉴"]},
                    "lunch": {"regular": ["점심 메뉴"]},
                    "dinner": {"regular": ["저녁 메뉴"]},
                },
            }

    def fake_get(url, *args, **kwargs):
        calls.append(url)
        date_text = url.rstrip("/").rsplit("/", 1)[-1]
        return _FakeMealResponse(date_text)

    monkeypatch.setattr(requests, "get", fake_get)

    response = client.get("/api/classes/schoollife/meal?offset=1")

    expected_date = (datetime.now(timezone(timedelta(hours=9))).date() + timedelta(days=1)).strftime("%Y-%m-%d")
    assert response.status_code == 200
    assert response.get_json()["date"] == expected_date
    assert calls[-1].endswith(f"/{expected_date}")


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
