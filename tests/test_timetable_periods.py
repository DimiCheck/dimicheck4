import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def test_normalize_timetable_rows_sorts_and_deduplicates():
    from class_routes import _normalize_timetable_rows

    rows = [
        {"PERIO": "7교시", "ITRT_CNTNT": "창체"},
        {"PERIO": "2", "ITRT_CNTNT": "수학"},
        {"PERIO": "6", "ITRT_CNTNT": "영어"},
        {"PERIO": "2교시", "ITRT_CNTNT": "수학"},
        {"PERIO": "1", "ITRT_CNTNT": "국어"},
        {"PERIO": None, "ITRT_CNTNT": "창의융합"},
        {"PERIO": "invalid", "ITRT_CNTNT": "동아리"},
        {"PERIO": "5", "ITRT_CNTNT": ""},
    ]

    lessons, max_period = _normalize_timetable_rows(rows)

    assert max_period == 7
    assert lessons == [
        {"period": 1, "subject": "국어"},
        {"period": 2, "subject": "수학"},
        {"period": 6, "subject": "영어"},
        {"period": 7, "subject": "창체"},
        {"period": None, "subject": "동아리"},
        {"period": None, "subject": "창의융합"},
    ]


def test_fetch_timetable_uses_same_fallback_neis_key_as_client(monkeypatch):
    from class_routes import _NEIS_FALLBACK_API_KEY, _fetch_timetable_from_api
    from config import config

    captured = {}

    class _FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"hisTimetable": [{}, {"row": []}]}

    def fake_get(url, params=None, timeout=None):
        captured["url"] = url
        captured["params"] = params or {}
        captured["timeout"] = timeout
        return _FakeResponse()

    monkeypatch.setattr("class_routes.requests.get", fake_get)
    monkeypatch.setattr(config, "NEIS_API_KEY", None)

    lessons, max_period = _fetch_timetable_from_api(2, 4)

    assert lessons == []
    assert max_period == 0
    assert captured["url"] == "https://open.neis.go.kr/hub/hisTimetable"
    assert captured["params"]["KEY"] == _NEIS_FALLBACK_API_KEY
    assert captured["params"]["GRADE"] == 2
    assert captured["params"]["CLASS_NM"] == 4
