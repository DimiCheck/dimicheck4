from __future__ import annotations

import json
from datetime import datetime, timezone, timedelta

from flask import Blueprint, jsonify, request, session
from sqlalchemy import func

from extensions import db
from models import Vote, VoteResponse, ClassState
from utils import is_board_session_active, is_teacher_session_active
import re

blueprint = Blueprint("vote", __name__, url_prefix="/api/classes/vote")
DEFAULT_CHANNEL = "home"
MAX_CHANNEL_NAME_LENGTH = 30
CHANNEL_NAME_PATTERN = re.compile(r"^[A-Za-z0-9가-힣 _\\-]+$")


def _normalize_channel_name(value: str | None) -> str:
    name = (value or "").strip()
    if not name:
        return DEFAULT_CHANNEL
    name = re.sub(r"\\s+", " ", name)
    if len(name) > MAX_CHANNEL_NAME_LENGTH:
        name = name[:MAX_CHANNEL_NAME_LENGTH]
    return name


def _normalize_channel_list(raw_list) -> list[str]:
    channels = raw_list if isinstance(raw_list, list) else []
    normalized: list[str] = []
    seen = set()
    for ch in channels:
        if not isinstance(ch, str):
            continue
        name = _normalize_channel_name(ch)
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        normalized.append(name)
    if DEFAULT_CHANNEL.casefold() not in seen:
        normalized.insert(0, DEFAULT_CHANNEL)
    return normalized


def _normalize_channel_memberships(raw_memberships, channels: list[str], grade: int | None, section: int | None) -> dict[str, list[dict]]:
    memberships = raw_memberships if isinstance(raw_memberships, dict) else {}
    result: dict[str, list[dict]] = {}
    for ch in channels:
        entries = []
        seen = set()
        raw_entries = memberships.get(ch) if isinstance(memberships.get(ch), list) else []
        for entry in raw_entries:
            if not isinstance(entry, dict):
                continue
            g = _normalize_class_value(entry.get("grade"))
            s = _normalize_class_value(entry.get("section"))
            if g is None or s is None:
                continue
            key = f"{g}-{s}"
            if key in seen:
                continue
            seen.add(key)
            entries.append({"grade": g, "section": s})

        if grade is not None and section is not None:
            key = f"{grade}-{section}"
            if key not in seen:
                entries.append({"grade": grade, "section": section})
        result[ch] = entries
    return result


def _load_channel_state(grade: int, section: int, *, persist: bool = False) -> tuple[list[str], dict, ClassState | None, dict]:
    state = ClassState.query.filter_by(grade=grade, section=section).first()
    if not state:
        payload = {
            "magnets": {},
            "channels": [DEFAULT_CHANNEL],
            "channelMemberships": {DEFAULT_CHANNEL: [{"grade": grade, "section": section}]}
        }
        state = ClassState(grade=grade, section=section, data=json.dumps(payload, ensure_ascii=False))
        db.session.add(state)
        if persist:
            db.session.commit()
        return payload["channels"], payload, state, payload["channelMemberships"]

    try:
        payload = json.loads(state.data) if state.data else {}
    except (TypeError, json.JSONDecodeError):
        payload = {}

    channels = _normalize_channel_list(payload.get("channels"))
    memberships = _normalize_channel_memberships(payload.get("channelMemberships"), channels, grade, section)
    payload["channels"] = channels
    payload["channelMemberships"] = memberships

    if persist:
        state.data = json.dumps(payload, ensure_ascii=False)
        db.session.add(state)
        db.session.commit()

    return channels, payload, state, memberships


def _channel_exists(channels: list[str], name: str) -> bool:
    target = name.casefold()
    return any(ch.casefold() == target for ch in channels)


def _is_member_of_channel(memberships: dict, channel: str, grade: int, section: int) -> bool:
    return any(
        _normalize_class_value(m.get("grade")) == grade
        and _normalize_class_value(m.get("section")) == section
        for m in memberships.get(channel, [])
    )


def _normalize_class_value(value: int | str | None) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _extract_first(mapping: dict, *keys: str) -> int | str | None:
    for key in keys:
        if key in mapping:
            return mapping.get(key)
    return None


def _split_student_identifier(value: int | str | None) -> tuple[int | None, int | None, int | None]:
    if value is None:
        return None, None, None

    digits = "".join(ch for ch in str(value) if ch.isdigit())
    if not digits:
        return None, None, None

    if len(digits) >= 3:
        grade = _normalize_class_value(digits[0])
        number = _normalize_class_value(digits[-2:])
        section_digits = digits[1:-2]
        section = _normalize_class_value(section_digits) if section_digits else None
        return grade, section, number

    return None, None, _normalize_class_value(digits)


def _get_student_session_info() -> tuple[int | None, int | None, int | None]:
    user = session.get("user") or {}
    user_type = str(user.get("type", "")).lower()
    if user_type != "student":
        return None, None, None

    grade = _normalize_class_value(_extract_first(user, "grade", "grade_no", "gradeNo"))
    section = _normalize_class_value(
        _extract_first(
            user,
            "class",
            "class_no",
            "classNo",
            "classroom",
            "section",
            "section_no",
            "sectionNo",
        )
    )

    identifier = _extract_first(
        user,
        "number",
        "student_number",
        "studentNumber",
        "student_no",
        "studentNo",
    )
    derived_grade, derived_section, derived_number = _split_student_identifier(identifier)
    if grade is None:
        grade = derived_grade
    if section is None:
        section = derived_section

    number = derived_number
    if number is None:
        _, _, number = _split_student_identifier(
            _extract_first(user, "seat_number", "seatNumber", "number_only")
        )

    return grade, section, number


def _student_matches(grade: int | None, section: int | None) -> bool:
    if grade is None or section is None:
        return False

    session_grade, session_section, _ = _get_student_session_info()
    if session_grade is None or session_section is None:
        return False

    return session_grade == grade and session_section == section


def _is_authorized(grade: int | None, section: int | None) -> bool:
    return (
        is_teacher_session_active()
        or is_board_session_active(grade, section)
        or _student_matches(grade, section)
    )


def _load_vote_options(vote: Vote) -> list[str]:
    try:
        return json.loads(vote.options)
    except (TypeError, json.JSONDecodeError):
        return []


def _build_vote_counts(vote: Vote, options: list[str]) -> tuple[dict[str, int], int]:
    counts = {option: 0 for option in options}
    rows = (
        db.session.query(VoteResponse.option_index, func.count(VoteResponse.id))
        .filter(VoteResponse.vote_id == vote.id)
        .group_by(VoteResponse.option_index)
        .all()
    )
    for option_index, count in rows:
        if 0 <= option_index < len(options):
            counts[options[option_index]] = count
    total = sum(counts.values())
    return counts, total


def _serialize_vote_result(vote: Vote | None) -> dict | None:
    if not vote:
        return None
    options = _load_vote_options(vote)
    counts, total = _build_vote_counts(vote, options)
    return {
        "voteId": vote.id,
        "question": vote.question,
        "options": options,
        "counts": counts,
        "totalVotes": total,
        "createdAt": vote.created_at.isoformat(),
        "expiresAt": vote.expires_at.isoformat(),
        "isActive": bool(vote.is_active and vote.expires_at > datetime.utcnow()),
        "channel": getattr(vote, "channel", DEFAULT_CHANNEL)
    }


@blueprint.get("/active")
def get_active_vote():
    """Get the currently active vote for a class"""
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    requested_channel = _normalize_channel_name(request.args.get("channel"))

    if grade is None or section is None:
        return jsonify({"error": "missing grade or section"}), 400

    if not _is_authorized(grade, section):
        return jsonify({"error": "forbidden"}), 403

    channels, payload, _, memberships = _load_channel_state(grade, section, persist=True)
    channel = requested_channel if _channel_exists(channels, requested_channel) else DEFAULT_CHANNEL
    if not _is_member_of_channel(memberships, channel, grade, section):
        return jsonify({"error": "forbidden"}), 403

    member_classes = memberships.get(channel) or [{"grade": grade, "section": section}]

    now = datetime.utcnow()

    # Find active vote that hasn't expired
    from sqlalchemy import or_, and_
    member_conditions = []
    for m in member_classes:
        g = _normalize_class_value(m.get("grade"))
        s = _normalize_class_value(m.get("section"))
        if g is None or s is None:
            continue
        member_conditions.append(and_(Vote.grade == g, Vote.section == s))

    vote = None
    if member_conditions:
        vote = Vote.query.filter(
            Vote.channel == channel,
            Vote.is_active == True,
            Vote.expires_at > now,
            or_(*member_conditions)
        ).order_by(Vote.created_at.desc()).first()

    if not vote:
        last_vote = (
            Vote.query.filter(
                Vote.channel == channel,
                or_(*member_conditions)
            )
            .order_by(Vote.created_at.desc())
            .first() if member_conditions else None
        )
        last_result = _serialize_vote_result(last_vote)
        if last_result:
            return jsonify({"active": False, "lastResult": last_result, "channel": channel})
        return jsonify({"active": False})

    options = _load_vote_options(vote)
    counts, total_votes = _build_vote_counts(vote, options)

    # Check if current student has voted
    session_grade, session_section, session_number = _get_student_session_info()
    my_vote = []
    if session_number is not None:
        my_response = VoteResponse.query.filter_by(
            vote_id=vote.id,
            student_number=session_number
        ).first()
        if my_response is not None and 0 <= my_response.option_index < len(options):
            my_vote = [options[my_response.option_index]]

    return jsonify({
        "active": True,
        "id": vote.id,
        "voteId": vote.id,  # Frontend expects voteId
        "question": vote.question,
        "options": options,
        "counts": counts,
        "myVote": my_vote,
        "expiresAt": vote.expires_at.isoformat(),
        "channel": vote.channel,
        "maxChoices": 1,  # Currently only single choice is supported
        "totalVotes": total_votes
    })


@blueprint.post("/create")
def create_vote():
    """Create a new vote"""
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    requested_channel = _normalize_channel_name(request.args.get("channel"))

    if grade is None or section is None:
        return jsonify({"error": "missing grade or section"}), 400

    session_grade, session_section, session_number = _get_student_session_info()
    is_teacher = is_teacher_session_active()
    is_board = is_board_session_active(grade, section)

    # Only teachers, board members, or students from the same class can create votes
    if not is_teacher and not is_board:
        if session_grade != grade or session_section != section or session_number is None:
            return jsonify({"error": "forbidden"}), 403

    channels, payload, _, memberships = _load_channel_state(grade, section, persist=True)
    channel = requested_channel if _channel_exists(channels, requested_channel) else DEFAULT_CHANNEL
    if not _is_member_of_channel(memberships, channel, grade, section):
        return jsonify({"error": "forbidden"}), 403
    member_classes = memberships.get(channel) or [{"grade": grade, "section": section}]

    payload = request.get_json() or {}
    question = (payload.get("question") or "").strip()
    options = payload.get("options") or []
    duration_minutes = payload.get("duration", 5)

    if not question:
        return jsonify({"error": "question is required"}), 400

    if not isinstance(options, list) or len(options) < 2:
        return jsonify({"error": "at least 2 options are required"}), 400

    # Limit duration
    duration_minutes = max(1, min(duration_minutes, 60))

    now = datetime.utcnow()
    expires_at = now + timedelta(minutes=duration_minutes)

    # Deactivate any existing active votes for this channel and its members
    from sqlalchemy import or_, and_
    member_conditions = []
    for m in member_classes:
        g = _normalize_class_value(m.get("grade"))
        s = _normalize_class_value(m.get("section"))
        if g is None or s is None:
            continue
        member_conditions.append(and_(Vote.grade == g, Vote.section == s))
    if member_conditions:
        Vote.query.filter(
            Vote.channel == channel,
            Vote.is_active == True,
            or_(*member_conditions)
        ).update({"is_active": False})

    created_by = session_number if session_number is not None else 0

    new_vote = Vote(
        grade=grade,
        section=section,
        channel=channel,
        question=question,
        options=json.dumps(options),
        created_by=created_by,
        expires_at=expires_at,
        is_active=True
    )

    db.session.add(new_vote)
    db.session.commit()

    return jsonify({
        "ok": True,
        "vote": {
            "id": new_vote.id,
            "question": new_vote.question,
            "options": options,
            "expiresAt": new_vote.expires_at.isoformat(),
            "channel": new_vote.channel
        }
    })


@blueprint.post("/respond")
def respond_to_vote():
    """Submit a vote response"""
    payload = request.get_json() or {}

    # Accept voteId from request body (frontend sends it this way)
    vote_id = payload.get("voteId")

    if vote_id is None:
        return jsonify({"error": "missing vote_id"}), 400

    vote = Vote.query.get(vote_id)
    if not vote:
        return jsonify({"error": "vote not found"}), 404

    # Check if vote is still active and not expired
    now = datetime.utcnow()
    if not vote.is_active or vote.expires_at <= now:
        return jsonify({"error": "vote has ended"}), 400

    session_grade, session_section, session_number = _get_student_session_info()
    if session_number is None:
        return jsonify({"error": "student session required"}), 403

    is_teacher = is_teacher_session_active()
    is_board = is_board_session_active(vote.grade, vote.section)
    channel = getattr(vote, "channel", DEFAULT_CHANNEL)

    if not is_teacher and not is_board:
        if session_grade is None or session_section is None:
            return jsonify({"error": "forbidden"}), 403
        channels, _, _, memberships = _load_channel_state(session_grade, session_section, persist=True)
        if not _channel_exists(channels, channel) or not _is_member_of_channel(memberships, channel, session_grade, session_section):
            return jsonify({"error": "forbidden"}), 403

    # Frontend sends "selected" as an array of option strings
    # We need to convert to option indices
    selected = payload.get("selected", [])

    if not selected or len(selected) == 0:
        return jsonify({"error": "no option selected"}), 400

    # Parse vote options
    try:
        options = json.loads(vote.options)
    except json.JSONDecodeError:
        return jsonify({"error": "invalid vote data"}), 500

    # Get the first selected option and find its index
    selected_option = selected[0]
    try:
        option_index = options.index(selected_option)
    except ValueError:
        return jsonify({"error": "invalid option selected"}), 400

    # Check if student already voted
    existing_response = VoteResponse.query.filter_by(
        vote_id=vote_id,
        student_number=session_number
    ).first()

    if existing_response:
        # Update existing response
        existing_response.option_index = option_index
    else:
        # Create new response
        new_response = VoteResponse(
            vote_id=vote_id,
            student_number=session_number,
            option_index=option_index
        )
        db.session.add(new_response)

    db.session.commit()

    return jsonify({"ok": True})


@blueprint.post("/close")
def close_vote():
    """Close an active vote (teacher/board only)"""
    vote_id = request.args.get("vote_id", type=int)

    if vote_id is None:
        return jsonify({"error": "missing vote_id"}), 400

    vote = Vote.query.get(vote_id)
    if not vote:
        return jsonify({"error": "vote not found"}), 404

    is_teacher = is_teacher_session_active()
    is_board = is_board_session_active(vote.grade, vote.section)

    if not is_teacher and not is_board:
        return jsonify({"error": "forbidden"}), 403

    vote.is_active = False
    db.session.commit()

    return jsonify({"ok": True})
