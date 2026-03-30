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
