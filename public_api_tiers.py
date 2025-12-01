from __future__ import annotations

from typing import Tuple

DEFAULT_TIER = "tier1"
TIER2 = "tier2"
SUPER_TIER = "super"
GOOGLE_FORM_URL = "https://forms.gle/hQdf64mHYu1TdVh39"
UNIT_SCALE = 10  # store usage as integer of tenth units
TIER2_DAILY_THRESHOLD = 20
TIER2_REQUIRED_DAYS = 3
TIER2_REQUIRED_TOTAL = 150

TIER_LIMITS: dict[str, dict[str, object]] = {
    # minute/daily are stored in scaled units (UNIT_SCALE = 10 → 1U = 10)
    "tier1": {"minute": 100 * UNIT_SCALE, "daily": 100 * UNIT_SCALE, "label": "Tier 1"},
    "tier2": {"minute": 300 * UNIT_SCALE, "daily": 300 * UNIT_SCALE, "label": "Tier 2"},
    "super": {"minute": 2000 * UNIT_SCALE, "daily": 2000 * UNIT_SCALE, "label": "Super Tier"},
}


def get_limits_for_tier(tier: str | None) -> Tuple[int, int]:
    spec = TIER_LIMITS.get(tier or DEFAULT_TIER, TIER_LIMITS[DEFAULT_TIER])
    return int(spec["minute"]), int(spec["daily"])


def get_tier_label(tier: str | None) -> str:
    spec = TIER_LIMITS.get(tier or DEFAULT_TIER, TIER_LIMITS[DEFAULT_TIER])
    return str(spec.get("label", tier or DEFAULT_TIER)).title()


def determine_highest_tier(tiers: list[str | None]) -> str:
    best_tier = DEFAULT_TIER
    _, best_daily = get_limits_for_tier(best_tier)
    for tier in tiers:
        if not tier:
            continue
        _, daily = get_limits_for_tier(tier)
        if daily > best_daily:
            best_daily = daily
            best_tier = tier
    return best_tier
