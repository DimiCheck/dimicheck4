import json
import logging
import os
from pathlib import Path
import threading
import time

import gspread

from config import config

_CACHE_TTL_SECONDS = int(os.getenv("CLASS_CONFIG_CACHE_TTL_SECONDS", "60"))
_DISK_CACHE_PATH = Path(
    os.getenv(
        "CLASS_CONFIG_CACHE_PATH",
        Path(__file__).resolve().with_name(".class_config_cache.json"),
    )
)
_cache_lock = threading.Lock()
_cached_configs: dict[tuple[int, int], dict[str, object]] = {}
_last_fetch_ts = 0.0


def _sheet_bool(value: object, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value).strip().lower()
    if text in {"1", "true", "t", "yes", "y", "on"}:
        return True
    if text in {"0", "false", "f", "no", "n", "off", ""}:
        return False
    return default


def _fetch_configs_from_sheet() -> dict[tuple[int, int], dict[str, object]]:
    gc = gspread.service_account(config.json_file_path)
    sh = gc.open_by_url(config.spreadsheet_url)
    ws = sh.worksheet("시트1")

    records = ws.get_all_records()
    configs: dict[tuple[int, int], dict[str, object]] = {}
    for row in records:
        grade = row["grade"]
        section = row["section"]

        raw_skip = str(row.get("skip_numbers", "")).strip()
        skip_numbers = []
        if raw_skip:
            try:
                skip_numbers = json.loads(raw_skip)
            except json.JSONDecodeError:
                skip_numbers = [int(x.strip()) for x in raw_skip.split(",") if x.strip()]

        configs[(grade, section)] = {
            "end": row["end"],
            "skip_numbers": skip_numbers,
            "pin": row["pin"],
            "chat_enabled": _sheet_bool(row.get("chat_enabled"), False),
        }
    return configs


def _serialize_configs(configs: dict[tuple[int, int], dict[str, object]]) -> list[dict[str, object]]:
    serialized: list[dict[str, object]] = []
    for (grade, section), payload in configs.items():
        serialized.append(
            {
                "grade": grade,
                "section": section,
                "config": payload,
            }
        )
    return serialized


def _deserialize_configs(raw_entries: object) -> dict[tuple[int, int], dict[str, object]]:
    configs: dict[tuple[int, int], dict[str, object]] = {}
    if not isinstance(raw_entries, list):
        return configs

    for entry in raw_entries:
        if not isinstance(entry, dict):
            continue

        grade = entry.get("grade")
        section = entry.get("section")
        payload = entry.get("config")
        if not isinstance(grade, int) or not isinstance(section, int) or not isinstance(payload, dict):
            continue
        configs[(grade, section)] = payload

    return configs


def _write_configs_to_disk_cache(configs: dict[tuple[int, int], dict[str, object]]) -> None:
    try:
        _DISK_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        _DISK_CACHE_PATH.write_text(
            json.dumps(_serialize_configs(configs), ensure_ascii=False),
            encoding="utf-8",
        )
    except OSError as exc:
        logging.warning("Failed to persist class config cache to %s: %s", _DISK_CACHE_PATH, exc)


def _load_configs_from_disk_cache() -> dict[tuple[int, int], dict[str, object]]:
    try:
        if not _DISK_CACHE_PATH.exists():
            return {}
        raw_entries = json.loads(_DISK_CACHE_PATH.read_text(encoding="utf-8"))
    except OSError as exc:
        logging.warning("Failed to read class config cache from %s: %s", _DISK_CACHE_PATH, exc)
        return {}
    except json.JSONDecodeError as exc:
        logging.warning("Failed to decode class config cache from %s: %s", _DISK_CACHE_PATH, exc)
        return {}

    configs = _deserialize_configs(raw_entries)
    if not configs:
        logging.warning("Class config cache at %s was empty or invalid", _DISK_CACHE_PATH)
    return configs


def load_class_config(force_refresh: bool = False) -> dict[tuple[int, int], dict[str, object]]:
    """Load class configuration from Google Sheets with in-memory caching.

    The cache reduces the number of Google Sheets API calls and prevents quota
    errors from breaking requests. If the remote call fails, the most recent
    cached data is returned instead.
    """
    global _cached_configs, _last_fetch_ts

    with _cache_lock:
        now = time.monotonic()
        if not force_refresh and _cached_configs and (now - _last_fetch_ts) < _CACHE_TTL_SECONDS:
            return _cached_configs

        try:
            _cached_configs = _fetch_configs_from_sheet()
            _last_fetch_ts = time.monotonic()
            _write_configs_to_disk_cache(_cached_configs)
        except gspread.exceptions.APIError as exc:
            logging.warning("Failed to refresh class config from Sheets (APIError): %s", exc)
            if not _cached_configs:
                _cached_configs = _load_configs_from_disk_cache()
                if _cached_configs:
                    logging.warning("Using persisted class config snapshot from %s", _DISK_CACHE_PATH)
            if _cached_configs:
                _last_fetch_ts = time.monotonic()
                return _cached_configs
            logging.error("No class config snapshot available; continuing with empty config set")
            return {}
        except Exception as exc:
            logging.exception("Unexpected error while loading class configs: %s", exc)
            if not _cached_configs:
                _cached_configs = _load_configs_from_disk_cache()
                if _cached_configs:
                    logging.warning("Using persisted class config snapshot from %s", _DISK_CACHE_PATH)
            if _cached_configs:
                _last_fetch_ts = time.monotonic()
                return _cached_configs
            logging.error("No class config snapshot available after unexpected error; continuing with empty config set")
            return {}

        return _cached_configs
