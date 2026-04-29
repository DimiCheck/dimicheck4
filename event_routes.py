from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import hmac
import json
import secrets
import unicodedata
from zoneinfo import ZoneInfo

from flask import Blueprint, jsonify, request, session
from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError

from extensions import db
from models import CoinEvent, CoinEventAttempt, CoinEventClaim, StudentWallet, User, WalletTransaction
from utils import is_teacher_session_active

blueprint = Blueprint("coin_events", __name__, url_prefix="/api/events")

KST = ZoneInfo("Asia/Seoul")
MIN_QUIZ_REWARD = 10
MAX_QUIZ_REWARD = 50
DAILY_QUIZ_CLAIM_LIMIT = 3


def _json_error(message: str, status: int):
    return jsonify({"error": message}), status


def _normalize_int(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _utcnow_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _today_key() -> str:
    return datetime.now(KST).date().isoformat()


def _parse_kst_datetime(value) -> datetime | None:
    if value in (None, ""):
        return None
    raw = str(value).strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=KST)
    return parsed.astimezone(timezone.utc).replace(tzinfo=None)


def _format_kst_datetime(value: datetime | None) -> str | None:
    if not value:
        return None
    normalized = value
    if normalized.tzinfo is None:
        normalized = normalized.replace(tzinfo=timezone.utc)
    return normalized.astimezone(KST).isoformat()


def _normalize_answer(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return "".join(ch for ch in normalized if ch.isalnum())


def _hash_answer(answer: str, salt: str) -> str:
    return hashlib.sha256(f"{salt}:{answer}".encode("utf-8")).hexdigest()


def _answer_matches(event: CoinEvent, answer: str) -> bool:
    normalized = _normalize_answer(answer)
    if not normalized:
        return False
    try:
        hashes = json.loads(event.answer_hashes or "[]")
    except json.JSONDecodeError:
        hashes = []
    submitted = _hash_answer(normalized, event.answer_salt)
    return any(hmac.compare_digest(str(saved), submitted) for saved in hashes)


def _build_answer_hashes(answer_values: list[str]) -> tuple[str, str] | None:
    normalized = []
    for answer in answer_values:
        value = _normalize_answer(answer)
        if value and value not in normalized:
            normalized.append(value)
    if not normalized:
        return None
    salt = secrets.token_hex(16)
    hashes = [_hash_answer(answer, salt) for answer in normalized]
    return salt, json.dumps(hashes)


def _ensure_event_tables() -> bool:
    try:
        StudentWallet.__table__.create(bind=db.engine, checkfirst=True)
        WalletTransaction.__table__.create(bind=db.engine, checkfirst=True)
        CoinEvent.__table__.create(bind=db.engine, checkfirst=True)
        CoinEventClaim.__table__.create(bind=db.engine, checkfirst=True)
        CoinEventAttempt.__table__.create(bind=db.engine, checkfirst=True)
        return True
    except Exception:
        try:
            db.session.rollback()
        except Exception:
            pass
        return False


def _get_student_session_info() -> tuple[dict | None, int | None, int | None, int | None]:
    user = session.get("user")
    if not isinstance(user, dict) or str(user.get("type", "")).lower() != "student":
        return None, None, None, None
    grade = _normalize_int(user.get("grade"))
    section = _normalize_int(user.get("section") or user.get("class") or user.get("class_no"))
    number = _normalize_int(user.get("number"))
    if grade is None or section is None or number is None:
        return user, None, None, None
    return user, grade, section, number


def _require_student_context():
    user, grade, section, number = _get_student_session_info()
    if user is None:
        return None, None, None, None, _json_error("login_required", 401)
    if grade is None or section is None or number is None:
        return None, None, None, None, _json_error("forbidden", 403)
    user_id = _normalize_int(user.get("id"))
    if user_id is None:
        return None, None, None, None, _json_error("forbidden", 403)
    db_user = db.session.get(User, user_id)
    if not db_user:
        return None, None, None, None, _json_error("login_required", 401)
    return db_user, grade, section, number, None


def _require_teacher():
    if not is_teacher_session_active():
        return _json_error("forbidden", 403)
    return None


def _get_or_create_wallet(user_id: int, grade: int, section: int, number: int) -> StudentWallet:
    wallet = StudentWallet.query.filter_by(user_id=user_id).first()
    if wallet:
        wallet.grade = grade
        wallet.section = section
        wallet.student_number = number
        return wallet
    wallet = StudentWallet(
        user_id=user_id,
        grade=grade,
        section=section,
        student_number=number,
        coins=0,
        xp=0,
    )
    db.session.add(wallet)
    db.session.flush()
    return wallet


def _serialize_wallet(wallet: StudentWallet) -> dict:
    xp = max(0, int(wallet.xp or 0))
    return {
        "coins": max(0, int(wallet.coins or 0)),
        "xp": xp,
        "level": max(1, int(xp // 500) + 1),
    }


def _event_applies_to(event: CoinEvent, grade: int, section: int) -> bool:
    return bool(event.target_all) or (
        int(event.target_grade or 0) == int(grade) and int(event.target_section or 0) == int(section)
    )


def _event_is_open(event: CoinEvent, now: datetime | None = None) -> bool:
    now = now or _utcnow_naive()
    if not event.is_active:
        return False
    if event.starts_at and event.starts_at > now:
        return False
    if event.ends_at and event.ends_at <= now:
        return False
    return True


def _daily_quiz_claim_count(user_id: int, claim_date: str) -> int:
    return (
        CoinEventClaim.query.join(CoinEvent, CoinEventClaim.event_id == CoinEvent.id)
        .filter(
            CoinEventClaim.user_id == user_id,
            CoinEventClaim.claim_date == claim_date,
            CoinEvent.event_type == "quiz",
        )
        .count()
    )


def _serialize_event_for_student(event: CoinEvent, claimed_event_ids: set[int]) -> dict:
    return {
        "id": event.id,
        "type": event.event_type,
        "title": event.title,
        "description": event.description or "",
        "question": event.question,
        "hint": event.hint or "",
        "rewardCoins": int(event.reward_coins or 0),
        "claimed": event.id in claimed_event_ids,
        "startsAt": _format_kst_datetime(event.starts_at),
        "endsAt": _format_kst_datetime(event.ends_at),
    }


def _claim_count_for_event(event_id: int) -> int:
    return CoinEventClaim.query.filter_by(event_id=event_id).count()


def _serialize_event_for_teacher(event: CoinEvent) -> dict:
    return {
        "id": event.id,
        "type": event.event_type,
        "title": event.title,
        "description": event.description or "",
        "question": event.question,
        "hint": event.hint or "",
        "rewardCoins": int(event.reward_coins or 0),
        "targetAll": bool(event.target_all),
        "targetGrade": event.target_grade,
        "targetSection": event.target_section,
        "active": bool(event.is_active),
        "open": _event_is_open(event),
        "startsAt": _format_kst_datetime(event.starts_at),
        "endsAt": _format_kst_datetime(event.ends_at),
        "claimCount": _claim_count_for_event(event.id),
        "createdAt": _format_kst_datetime(event.created_at),
    }


def _event_query_for_student(grade: int, section: int):
    return CoinEvent.query.filter(
        CoinEvent.event_type == "quiz",
        CoinEvent.is_active.is_(True),
        or_(
            CoinEvent.target_all.is_(True),
            (CoinEvent.target_grade == grade) & (CoinEvent.target_section == section),
        ),
    )


def _apply_event_payload(event: CoinEvent, payload: dict, *, require_answer: bool) -> tuple[CoinEvent | None, tuple | None]:
    title = str(payload.get("title") or "").strip()
    description = str(payload.get("description") or "").strip()
    question = str(payload.get("question") or "").strip()
    hint = str(payload.get("hint") or "").strip()
    answer = str(payload.get("answer") or "").strip()
    aliases_raw = payload.get("answerAliases") or []
    aliases = aliases_raw if isinstance(aliases_raw, list) else []
    reward = _normalize_int(payload.get("rewardCoins"))
    target_all = bool(payload.get("targetAll"))
    target_grade = _normalize_int(payload.get("targetGrade"))
    target_section = _normalize_int(payload.get("targetSection"))

    if not title or len(title) > 120:
        return None, _json_error("invalid title", 400)
    if not question or len(question) > 500:
        return None, _json_error("invalid question", 400)
    if len(description) > 500:
        description = description[:500]
    if len(hint) > 240:
        hint = hint[:240]
    if reward is None or reward < MIN_QUIZ_REWARD or reward > MAX_QUIZ_REWARD:
        return None, _json_error("reward must be between 10 and 50", 400)
    if not target_all and (target_grade is None or target_section is None):
        return None, _json_error("target class required", 400)
    if target_grade is not None and target_grade not in {1, 2, 3}:
        return None, _json_error("invalid target grade", 400)
    if target_section is not None and not (1 <= target_section <= 6):
        return None, _json_error("invalid target section", 400)
    if target_all:
        target_grade = None
        target_section = None

    event.title = title
    event.description = description or None
    event.question = question
    event.hint = hint or None
    event.reward_coins = reward
    event.target_all = target_all
    event.target_grade = target_grade
    event.target_section = target_section
    event.starts_at = _parse_kst_datetime(payload.get("startsAt"))
    event.ends_at = _parse_kst_datetime(payload.get("endsAt"))
    if event.starts_at and event.ends_at and event.starts_at >= event.ends_at:
        return None, _json_error("invalid event window", 400)
    if "active" in payload:
        event.is_active = bool(payload.get("active"))

    if answer or require_answer:
        answer_hashes = _build_answer_hashes([answer, *aliases])
        if not answer_hashes:
            return None, _json_error("answer required", 400)
        event.answer_salt, event.answer_hashes = answer_hashes

    return event, None


@blueprint.get("/me")
def get_my_events():
    if not _ensure_event_tables():
        return _json_error("event storage unavailable", 503)
    db_user, grade, section, number, error = _require_student_context()
    if error:
        return error

    now = _utcnow_naive()
    today = _today_key()
    wallet = _get_or_create_wallet(db_user.id, grade, section, number)
    claimed_rows = CoinEventClaim.query.filter_by(user_id=db_user.id).all()
    claimed_ids = {int(row.event_id) for row in claimed_rows}
    events = [
        event
        for event in _event_query_for_student(grade, section).order_by(CoinEvent.created_at.desc()).all()
        if _event_is_open(event, now)
    ]
    daily_count = _daily_quiz_claim_count(db_user.id, today)
    db.session.commit()

    return jsonify(
        {
            "wallet": _serialize_wallet(wallet),
            "dailyLimit": DAILY_QUIZ_CLAIM_LIMIT,
            "dailyClaimed": min(daily_count, DAILY_QUIZ_CLAIM_LIMIT),
            "dailyRemaining": max(0, DAILY_QUIZ_CLAIM_LIMIT - daily_count),
            "events": [_serialize_event_for_student(event, claimed_ids) for event in events],
        }
    )


@blueprint.post("/<int:event_id>/claim")
def claim_event(event_id: int):
    if not _ensure_event_tables():
        return _json_error("event storage unavailable", 503)
    db_user, grade, section, number, error = _require_student_context()
    if error:
        return error

    payload = request.get_json(silent=True) or {}
    answer = str(payload.get("answer") or "")
    event = db.session.get(CoinEvent, event_id)
    if not event or not _event_applies_to(event, grade, section) or not _event_is_open(event):
        return _json_error("event unavailable", 404)

    today = _today_key()
    if CoinEventClaim.query.filter_by(event_id=event.id, user_id=db_user.id).first():
        return _json_error("already claimed", 409)
    if _daily_quiz_claim_count(db_user.id, today) >= DAILY_QUIZ_CLAIM_LIMIT:
        return _json_error("daily limit reached", 429)

    is_correct = _answer_matches(event, answer)
    db.session.add(
        CoinEventAttempt(
            event_id=event.id,
            user_id=db_user.id,
            grade=grade,
            section=section,
            student_number=number,
            is_correct=is_correct,
        )
    )
    if not is_correct:
        db.session.commit()
        return _json_error("incorrect answer", 400)

    wallet = _get_or_create_wallet(db_user.id, grade, section, number)
    reward = max(MIN_QUIZ_REWARD, min(MAX_QUIZ_REWARD, int(event.reward_coins or 0)))
    wallet.coins = int(wallet.coins or 0) + reward
    wallet.updated_at = _utcnow_naive()
    claim = CoinEventClaim(
        event_id=event.id,
        user_id=db_user.id,
        grade=grade,
        section=section,
        student_number=number,
        reward_coins=reward,
        claim_date=today,
    )
    db.session.add(claim)
    db.session.flush()
    db.session.add(
        WalletTransaction(
            user_id=db_user.id,
            wallet_id=wallet.id,
            coin_delta=reward,
            xp_delta=0,
            source="event_quiz",
            source_detail=str(event.id),
            balance_after=wallet.coins,
        )
    )
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return _json_error("already claimed", 409)

    daily_count = _daily_quiz_claim_count(db_user.id, today)
    return jsonify(
        {
            "ok": True,
            "rewardCoins": reward,
            "wallet": _serialize_wallet(wallet),
            "dailyClaimed": min(daily_count, DAILY_QUIZ_CLAIM_LIMIT),
            "dailyRemaining": max(0, DAILY_QUIZ_CLAIM_LIMIT - daily_count),
        }
    )


@blueprint.get("/teacher")
def get_teacher_events():
    error = _require_teacher()
    if error:
        return error
    if not _ensure_event_tables():
        return _json_error("event storage unavailable", 503)
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    query = CoinEvent.query.filter_by(event_type="quiz")
    if grade is not None and section is not None:
        query = query.filter(
            or_(
                CoinEvent.target_all.is_(True),
                (CoinEvent.target_grade == grade) & (CoinEvent.target_section == section),
            )
        )
    events = query.order_by(CoinEvent.created_at.desc()).limit(120).all()
    return jsonify({"events": [_serialize_event_for_teacher(event) for event in events]})


@blueprint.post("")
def create_event():
    error = _require_teacher()
    if error:
        return error
    if not _ensure_event_tables():
        return _json_error("event storage unavailable", 503)
    payload = request.get_json(silent=True) or {}
    event = CoinEvent(
        event_type="quiz",
        title="",
        question="",
        answer_salt="",
        answer_hashes="[]",
        reward_coins=MIN_QUIZ_REWARD,
        target_all=False,
    )
    event, payload_error = _apply_event_payload(event, payload, require_answer=True)
    if payload_error:
        return payload_error
    db.session.add(event)
    db.session.commit()
    return jsonify({"ok": True, "event": _serialize_event_for_teacher(event)}), 201


@blueprint.patch("/<int:event_id>")
def update_event(event_id: int):
    error = _require_teacher()
    if error:
        return error
    if not _ensure_event_tables():
        return _json_error("event storage unavailable", 503)
    event = db.session.get(CoinEvent, event_id)
    if not event:
        return _json_error("event not found", 404)
    payload = request.get_json(silent=True) or {}
    if set(payload.keys()).issubset({"active"}):
        event.is_active = bool(payload.get("active"))
    else:
        event, payload_error = _apply_event_payload(event, payload, require_answer=False)
        if payload_error:
            return payload_error
    event.updated_at = _utcnow_naive()
    db.session.commit()
    return jsonify({"ok": True, "event": _serialize_event_for_teacher(event)})
