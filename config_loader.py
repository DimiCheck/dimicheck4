import json
import logging
import os
import threading
import time

import gspread

from config import config

_CACHE_TTL_SECONDS = int(os.getenv("CLASS_CONFIG_CACHE_TTL_SECONDS", "60"))
_cache_lock = threading.Lock()
_cached_configs: dict[tuple[int, int], dict[str, object]] = {}
_last_fetch_ts = 0.0


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
        }
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
        except gspread.exceptions.APIError as exc:
            logging.warning("Failed to refresh class config from Sheets (APIError): %s", exc)
            if _cached_configs:
                return _cached_configs
            raise
        except Exception as exc:
            logging.exception("Unexpected error while loading class configs: %s", exc)
            if _cached_configs:
                return _cached_configs
            raise

        return _cached_configs
