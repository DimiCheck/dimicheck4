import importlib
import json
from pathlib import Path
import sys

import gspread

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _reload_config_loader(monkeypatch, tmp_path):
    cache_path = tmp_path / "class_config_cache.json"
    monkeypatch.setenv("CLASS_CONFIG_CACHE_PATH", str(cache_path))
    sys.modules.pop("config_loader", None)
    return importlib.import_module("config_loader"), cache_path


def test_load_class_config_returns_empty_dict_when_sheet_bootstrap_fails(monkeypatch, tmp_path):
    config_loader, _cache_path = _reload_config_loader(monkeypatch, tmp_path)

    def failing_fetch():
        raise gspread.exceptions.APIError(
            {
                "code": 503,
                "message": "The service is currently unavailable.",
                "status": "UNAVAILABLE",
            }
        )

    monkeypatch.setattr(config_loader, "_fetch_configs_from_sheet", failing_fetch)

    assert config_loader.load_class_config(force_refresh=True) == {}


def test_load_class_config_uses_persisted_snapshot_when_sheet_is_unavailable(monkeypatch, tmp_path):
    config_loader, cache_path = _reload_config_loader(monkeypatch, tmp_path)

    fresh_configs = {
        (1, 2): {
            "end": 18,
            "skip_numbers": [3, 7],
            "pin": "1234",
            "chat_enabled": True,
        }
    }

    monkeypatch.setattr(config_loader, "_fetch_configs_from_sheet", lambda: fresh_configs)
    assert config_loader.load_class_config(force_refresh=True) == fresh_configs

    sys.modules.pop("config_loader", None)
    config_loader = importlib.import_module("config_loader")
    assert cache_path.exists()

    def failing_fetch():
        raise gspread.exceptions.APIError(
            {
                "code": 503,
                "message": "The service is currently unavailable.",
                "status": "UNAVAILABLE",
            }
        )

    monkeypatch.setattr(config_loader, "_fetch_configs_from_sheet", failing_fetch)

    assert config_loader.load_class_config(force_refresh=True) == fresh_configs
    assert json.loads(cache_path.read_text(encoding="utf-8")) == [
        {
            "grade": 1,
            "section": 2,
            "config": fresh_configs[(1, 2)],
        }
    ]
