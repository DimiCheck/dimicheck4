import importlib
import sys
from pathlib import Path

import gspread
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


def _load_app(monkeypatch, tmp_path):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'board-session.db'}")
    monkeypatch.setattr(gspread, "service_account", lambda _path: _FakeGSpreadClient())
    for collector in list(REGISTRY._collector_to_names):
        names = REGISTRY._collector_to_names.get(collector, ())
        if any(name.startswith("http_request") or name.startswith("http_requests") for name in names):
            REGISTRY.unregister(collector)

    removable_prefixes = (
        "app",
        "config",
        "config_loader",
        "utils",
        "ws",
        "eventlet",
        "account",
        "arcade_routes",
        "auth",
        "class_routes",
        "chat_routes",
        "developer_routes",
        "exports_routes",
        "mcp_routes",
        "oauth",
        "public_api",
        "vote_routes",
    )
    for module_name in list(sys.modules):
        if module_name == "main":
            continue
        if any(module_name == prefix or module_name.startswith(f"{prefix}.") for prefix in removable_prefixes):
            sys.modules.pop(module_name, None)

    app_module = importlib.import_module("app")
    app_module.app.config.update(TESTING=True)
    return app_module


def test_board_pin_login_marks_session_permanent(monkeypatch, tmp_path):
    app_module = _load_app(monkeypatch, tmp_path)
    monkeypatch.setattr(app_module, "load_class_config", lambda: {(2, 4): {"pin": "1234"}})

    client = app_module.app.test_client()
    response = client.post("/board?grade=2&section=4", data={"pin": "1234"})

    assert response.status_code == 200
    with client.session_transaction() as session_state:
        assert session_state["board_verified_2_4"] is True
        assert session_state.permanent is True

    cookie = response.headers.get("Set-Cookie", "")
    assert "Expires=" in cookie
