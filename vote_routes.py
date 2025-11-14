from __future__ import annotations

import json
from datetime import datetime, timezone, timedelta

from flask import Blueprint, jsonify, request, session
from sqlalchemy import func

from extensions import db
from models import Vote, VoteResponse
from utils import is_board_session_active, is_teacher_session_active

blueprint = Blueprint("vote", __name__, url_prefix="/api/classes/vote")


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


@blueprint.get("/active")
def get_active_vote():
    """Get the currently active vote for a class"""
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)

    if grade is None or section is None:
        return jsonify({"error": "missing grade or section"}), 400

    if not _is_authorized(grade, section):
        return jsonify({"error": "forbidden"}), 403

    now = datetime.utcnow()

    # Find active vote that hasn't expired
    vote = Vote.query.filter(
        Vote.grade == grade,
        Vote.section == section,
        Vote.is_active == True,
        Vote.expires_at > now
    ).order_by(Vote.created_at.desc()).first()

    if not vote:
        return jsonify({"active": False})

    # Parse options
    try:
        options = json.loads(vote.options)
    except json.JSONDecodeError:
        options = []

    # Get vote counts for each option
    responses = VoteResponse.query.filter_by(vote_id=vote.id).all()
    counts = {}
    for option_idx, option in enumerate(options):
        count = sum(1 for r in responses if r.option_index == option_idx)
        counts[option] = count

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
        "maxChoices": 1  # Currently only single choice is supported
    })


@blueprint.post("/create")
def create_vote():
    """Create a new vote"""
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)

    if grade is None or section is None:
        return jsonify({"error": "missing grade or section"}), 400

    session_grade, session_section, session_number = _get_student_session_info()
    is_teacher = is_teacher_session_active()
    is_board = is_board_session_active(grade, section)

    # Only teachers, board members, or students from the same class can create votes
    if not is_teacher and not is_board:
        if session_grade != grade or session_section != section or session_number is None:
            return jsonify({"error": "forbidden"}), 403

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

    # Deactivate any existing active votes for this class
    Vote.query.filter_by(
        grade=grade,
        section=section,
        is_active=True
    ).update({"is_active": False})

    created_by = session_number if session_number is not None else 0

    new_vote = Vote(
        grade=grade,
        section=section,
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
            "expiresAt": new_vote.expires_at.isoformat()
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

    if not _is_authorized(vote.grade, vote.section):
        return jsonify({"error": "forbidden"}), 403

    # Check if vote is still active and not expired
    now = datetime.utcnow()
    if not vote.is_active or vote.expires_at <= now:
        return jsonify({"error": "vote has ended"}), 400

    session_grade, session_section, session_number = _get_student_session_info()
    if session_number is None:
        return jsonify({"error": "student session required"}), 403

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
