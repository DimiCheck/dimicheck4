from __future__ import annotations

import json
from datetime import datetime, timezone, timedelta

from flask import Blueprint, jsonify, request, session
from extensions import db
from models import Vote, VoteResponse, ClassState
from utils import is_board_session_active, is_teacher_session_active
import re

blueprint = Blueprint("vote", __name__, url_prefix="/api/classes/vote")
DEFAULT_CHANNEL = "home"
MAX_CHANNEL_NAME_LENGTH = 30
MAX_VOTE_OPTIONS = 10
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
    options, _ = _load_vote_config(vote)
    return options


def _load_vote_config(vote: Vote) -> tuple[list[str], int]:
    try:
        payload = json.loads(vote.options)
    except (TypeError, json.JSONDecodeError):
        return [], 1

    max_choices = 1
    raw_options = payload
    if isinstance(payload, dict):
        raw_options = payload.get("options")
        parsed_max_choices = _normalize_class_value(payload.get("maxChoices") or payload.get("max_choices"))
        if parsed_max_choices is not None:
            max_choices = parsed_max_choices

    if not isinstance(raw_options, list):
        return [], 1

    options: list[str] = []
    for option in raw_options:
        text = str(option).strip()
        if text:
            options.append(text)

    if not options:
        return [], 1

    max_choices = max(1, min(max_choices, len(options)))
    return options, max_choices


def _normalize_vote_option_text(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _normalize_vote_creation_options(raw_options: object) -> tuple[list[str], str | None]:
    if not isinstance(raw_options, list):
        return [], "options must be a list"

    normalized: list[str] = []
    seen = set()
    for raw_option in raw_options:
        text = _normalize_vote_option_text(raw_option)
        if not text:
            return [], "empty options are not allowed"
        key = text.casefold()
        if key in seen:
            return [], "options must be unique"
        seen.add(key)
        normalized.append(text)

    if len(normalized) < 2:
        return [], "at least 2 options are required"
    if len(normalized) > MAX_VOTE_OPTIONS:
        return [], f"options cannot exceed {MAX_VOTE_OPTIONS}"
    return normalized, None


def _serialize_vote_config(options: list[str], max_choices: int) -> str:
    normalized_max_choices = max(1, min(int(max_choices), len(options) if options else 1))
    return json.dumps(
        {
            "options": options,
            "maxChoices": normalized_max_choices,
        },
        ensure_ascii=False,
    )


def _build_vote_response_key(grade: int | None, section: int | None, student_number: int | None) -> int | None:
    if grade is None or section is None or student_number is None:
        return None
    return (int(grade) * 10000) + (int(section) * 100) + int(student_number)


def _decode_vote_response_indices(stored_value: int | None, option_count: int, max_choices: int) -> list[int]:
    if stored_value is None or option_count <= 0:
        return []

    try:
        encoded = int(stored_value)
    except (TypeError, ValueError):
        return []

    if max_choices <= 1:
        return [encoded] if 0 <= encoded < option_count else []

    selected_indices: list[int] = []
    for idx in range(option_count):
        if encoded & (1 << idx):
            selected_indices.append(idx)
    return selected_indices


def _encode_vote_response_indices(selected_indices: list[int], max_choices: int) -> int:
    if max_choices <= 1:
        return selected_indices[0]

    bitmask = 0
    for idx in selected_indices:
        bitmask |= 1 << idx
    return bitmask


def _find_existing_vote_response(
    vote_id: int,
    session_grade: int | None,
    session_section: int | None,
    session_number: int | None,
    vote: Vote,
) -> VoteResponse | None:
    voter_key = _build_vote_response_key(session_grade, session_section, session_number)
    if voter_key is not None:
        response = VoteResponse.query.filter_by(vote_id=vote_id, student_number=voter_key).first()
        if response is not None:
            return response

    # Backward compatibility for legacy same-class responses stored as plain seat numbers.
    if (
        session_number is not None
        and session_grade == vote.grade
        and session_section == vote.section
    ):
        return VoteResponse.query.filter_by(vote_id=vote_id, student_number=session_number).first()

    return None


def _parse_selected_indices(payload: dict, options: list[str], max_choices: int) -> tuple[list[int], str | None]:
    raw_selected_indices = payload.get("selectedOptionIndexes")
    if raw_selected_indices is None:
        raw_selected_indices = payload.get("selectedIndices")

    selected_indices: list[int] = []
    if raw_selected_indices is not None:
        if not isinstance(raw_selected_indices, list):
            return [], "selected options must be a list"
        seen = set()
        for raw_index in raw_selected_indices:
            try:
                index = int(raw_index)
            except (TypeError, ValueError):
                return [], "invalid option selected"
            if not 0 <= index < len(options):
                return [], "invalid option selected"
            if index in seen:
                continue
            seen.add(index)
            selected_indices.append(index)
    else:
        selected_labels = payload.get("selected", [])
        if not isinstance(selected_labels, list):
            return [], "selected options must be a list"
        seen = set()
        for raw_label in selected_labels:
            label = _normalize_vote_option_text(raw_label)
            if not label:
                continue
            try:
                index = options.index(label)
            except ValueError:
                return [], "invalid option selected"
            if index in seen:
                continue
            seen.add(index)
            selected_indices.append(index)

    if not selected_indices:
        return [], "no option selected"

    if len(selected_indices) > max_choices:
        return [], f"you can select up to {max_choices} options"

    return selected_indices, None


def _build_vote_counts(vote: Vote, options: list[str], max_choices: int) -> tuple[dict[str, int], int]:
    counts = {option: 0 for option in options}
    rows = (
        db.session.query(VoteResponse.option_index)
        .filter(VoteResponse.vote_id == vote.id)
        .all()
    )
    total_responders = len(rows)
    for (stored_value,) in rows:
        for option_index in _decode_vote_response_indices(stored_value, len(options), max_choices):
            counts[options[option_index]] += 1
    return counts, total_responders


def _serialize_vote_result(vote: Vote | None) -> dict | None:
    if not vote:
        return None
    options, max_choices = _load_vote_config(vote)
    counts, total = _build_vote_counts(vote, options, max_choices)
    return {
        "voteId": vote.id,
        "question": vote.question,
        "options": options,
        "counts": counts,
        "totalVotes": total,
        "maxChoices": max_choices,
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

    options, max_choices = _load_vote_config(vote)
    counts, total_votes = _build_vote_counts(vote, options, max_choices)

    # Check if current student has voted
    session_grade, session_section, session_number = _get_student_session_info()
    my_vote = []
    my_vote_indices: list[int] = []
    if session_grade is not None and session_section is not None and session_number is not None:
        my_response = _find_existing_vote_response(vote.id, session_grade, session_section, session_number, vote)
        if my_response is not None:
            my_vote_indices = _decode_vote_response_indices(my_response.option_index, len(options), max_choices)
            my_vote = [options[idx] for idx in my_vote_indices if 0 <= idx < len(options)]

    return jsonify({
        "active": True,
        "id": vote.id,
        "voteId": vote.id,  # Frontend expects voteId
        "question": vote.question,
        "options": options,
        "counts": counts,
        "myVote": my_vote,
        "myVoteIndices": my_vote_indices,
        "createdAt": vote.created_at.isoformat(),
        "expiresAt": vote.expires_at.isoformat(),
        "channel": vote.channel,
        "maxChoices": max_choices,
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
    raw_options = payload.get("options") or []
    duration_minutes = payload.get("duration", 5)
    max_choices = _normalize_class_value(payload.get("maxChoices") or payload.get("max_choices")) or 1

    if not question:
        return jsonify({"error": "question is required"}), 400

    options, options_error = _normalize_vote_creation_options(raw_options)
    if options_error:
        return jsonify({"error": options_error}), 400

    if max_choices < 1 or max_choices > len(options):
        return jsonify({"error": "invalid maxChoices"}), 400

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
    replaced_count = 0
    if member_conditions:
        replaced_count = Vote.query.filter(
            Vote.channel == channel,
            Vote.is_active == True,
            or_(*member_conditions)
        ).update({"is_active": False}, synchronize_session=False)

    created_by = session_number if session_number is not None else 0

    new_vote = Vote(
        grade=grade,
        section=section,
        channel=channel,
        question=question,
        options=_serialize_vote_config(options, max_choices),
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
            "maxChoices": max_choices,
            "createdAt": new_vote.created_at.isoformat(),
            "expiresAt": new_vote.expires_at.isoformat(),
            "channel": new_vote.channel
        },
        "replacedExisting": bool(replaced_count),
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

    options, max_choices = _load_vote_config(vote)
    if not options:
        return jsonify({"error": "invalid vote data"}), 500

    selected_indices, selected_error = _parse_selected_indices(payload, options, max_choices)
    if selected_error:
        return jsonify({"error": selected_error}), 400
    encoded_response = _encode_vote_response_indices(selected_indices, max_choices)
    voter_key = _build_vote_response_key(session_grade, session_section, session_number) or session_number

    # Check if student already voted
    existing_response = _find_existing_vote_response(vote_id, session_grade, session_section, session_number, vote)

    if existing_response:
        # Update existing response
        existing_response.student_number = voter_key
        existing_response.option_index = encoded_response
    else:
        # Create new response
        new_response = VoteResponse(
            vote_id=vote_id,
            student_number=voter_key,
            option_index=encoded_response
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
