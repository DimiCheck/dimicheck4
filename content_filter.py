from __future__ import annotations

import re
from pathlib import Path


_CLEAN_PATTERN = re.compile(r"[^A-Za-z\u3131-\uD79D]+")
_SLANG_FILE = Path(__file__).resolve().parent / "slang.txt"


def _load_slang_words() -> set[str]:
    try:
        content = _SLANG_FILE.read_text(encoding="utf-8")
    except OSError:
        return set()

    words = set()
    for line in content.splitlines():
        word = line.strip()
        if word:
            words.add(word.casefold())
    return words


_SLANG_WORDS = _load_slang_words()


def normalize_text_for_slang_check(text: str | None) -> str:
    """Strip numbers/special chars and normalize casing for slang detection."""
    if not text:
        return ""
    cleaned = _CLEAN_PATTERN.sub("", str(text))
    return cleaned.casefold()


def contains_slang(text: str | None) -> bool:
    """Return True if the provided text includes any word from slang.txt."""
    normalized = normalize_text_for_slang_check(text)
    if not normalized or not _SLANG_WORDS:
        return False
    return any(word in normalized for word in _SLANG_WORDS)
