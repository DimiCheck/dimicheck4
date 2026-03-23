import importlib
import sys

import gspread


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
    sys.modules.pop("app", None)
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
