from datetime import datetime, timedelta, timezone
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def test_is_same_day_accepts_same_kst_day():
    from class_routes import _is_same_day

    ts1 = datetime(2026, 4, 24, 0, 5, tzinfo=timezone(timedelta(hours=9)))
    ts2 = datetime(2026, 4, 24, 23, 55, tzinfo=timezone(timedelta(hours=9)))

    assert _is_same_day(ts1, ts2) is True


def test_is_same_day_rejects_previous_kst_day():
    from class_routes import _is_same_day

    ts1 = datetime(2026, 4, 23, 23, 59, tzinfo=timezone(timedelta(hours=9)))
    ts2 = datetime(2026, 4, 24, 0, 0, tzinfo=timezone(timedelta(hours=9)))

    assert _is_same_day(ts1, ts2) is False
