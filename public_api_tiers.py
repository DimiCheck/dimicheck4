from __future__ import annotations

from typing import Tuple

DEFAULT_TIER = "tier1"
TIER2 = "tier2"
GOOGLE_FORM_URL = "https://forms.gle/hQdf64mHYu1TdVh39"
TIER2_MIN_DAILY_REQUESTS = 5
TIER2_STREAK_DAYS = 7

TIER_LIMITS: dict[str, dict[str, object]] = {
    "tier1": {"minute": 10, "daily": 50, "label": "Tier 1"},
    "tier2": {"minute": 15, "daily": 100, "label": "Tier 2"},
}


def get_limits_for_tier(tier: str | None) -> Tuple[int, int]:
    spec = TIER_LIMITS.get(tier or DEFAULT_TIER, TIER_LIMITS[DEFAULT_TIER])
    return int(spec["minute"]), int(spec["daily"])


def get_tier_label(tier: str | None) -> str:
    spec = TIER_LIMITS.get(tier or DEFAULT_TIER, TIER_LIMITS[DEFAULT_TIER])
    return str(spec.get("label", tier or DEFAULT_TIER)).title()
