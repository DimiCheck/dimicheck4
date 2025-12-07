from __future__ import annotations

import secrets
from datetime import datetime
from typing import Any, Dict, Tuple

import requests
from flask import (
    Blueprint,
    Response,
    jsonify,
    make_response,
    redirect,
    render_template,
    request,
    session,
    url_for,
)
from jose import jwt as jose_jwt
from jose.exceptions import JWTError

from auth.google import build_google_auth_url, exchange_code_for_tokens, verify_google_id_token
from auth.sessions import (
    clear_remembered_session,
    issue_session,
    persist_remembered_session,
)
from config import config
from extensions import db
from models import User, UserType, TermsConsent

blueprint = Blueprint("auth", __name__, url_prefix="/auth")

LEGACY_PUBLIC_KEY_URL = "https://auth.dimigo.net/oauth/public"
LEGACY_AUTHORIZE_URL = "https://auth.dimigo.net/oauth"
SERVICE_TERMS_VERSION = "v1"


def _coerce_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _extract_first(mapping: Dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in mapping:
            return mapping.get(key)
    return None


def _split_student_identifier(value: Any) -> Tuple[int | None, int | None, int | None]:
    if value is None:
        return None, None, None
    digits = "".join(ch for ch in str(value) if ch.isdigit())
    if not digits:
        return None, None, None
    if len(digits) >= 3:
        grade = _coerce_int(digits[0])
        seat = _coerce_int(digits[-2:])
        section_digits = digits[1:-2]
        section = _coerce_int(section_digits) if section_digits else None
        return grade, section, seat
    return None, None, _coerce_int(digits)


def _normalize_student_payload(data: Dict[str, Any]) -> None:
    user_type = str(data.get("type", "")).lower()
    if user_type != "student":
        return
    grade = _coerce_int(_extract_first(data, "grade", "grade_no", "gradeNo"))
    section = _coerce_int(
        _extract_first(
            data,
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
        data,
        "student_number",
        "studentNumber",
        "number",
        "student_no",
        "studentNo",
    )
    derived_grade, derived_section, seat = _split_student_identifier(identifier)
    if grade is None:
        grade = derived_grade
    if section is None:
        section = derived_section
    if seat is None:
        _, _, seat = _split_student_identifier(
            _extract_first(data, "seat_number", "seatNumber", "number_only")
        )
    composite = None
    if grade is not None and section is not None and seat is not None:
        composite = grade * 1000 + section * 100 + seat
    if grade is not None:
        data["grade"] = grade
    if section is not None:
        data["class"] = section
        data["class_no"] = section
        data["section"] = section
    if seat is not None:
        data["student_number"] = seat
        data["seat_number"] = seat
    if composite is not None:
        data["number"] = composite


def _build_legacy_login_url() -> str:
    params = {
        "client": config.OAUTH_CLIENT,
        "redirect": config.OAUTH_REDIRECT_URI,
    }
    return f"{LEGACY_AUTHORIZE_URL}?{requests.compat.urlencode(params)}"


def _get_legacy_public_key() -> str:
    resp = requests.get(config.OAUTH_PUBLIC_KEY_URL or LEGACY_PUBLIC_KEY_URL, timeout=5)
    resp.raise_for_status()
    return resp.text


def _coerce_user_type(value: str | None) -> UserType:
    if not value:
        return UserType.STUDENT
    lowered = value.lower()
    try:
        return UserType(lowered)
    except ValueError:
        return UserType.STUDENT


def _ensure_user_record(data: Dict[str, Any]) -> User:
    email = data.get("email")
    user = None
    if email:
        user = User.query.filter_by(email=email).first()
    student_number = data.get("student_number")
    grade = _coerce_int(data.get("grade"))
    class_no = _coerce_int(data.get("class") or data.get("class_no") or data.get("section"))
    if not user and grade is not None and class_no is not None and student_number is not None:
        user = (
            User.query.filter_by(grade=grade, class_no=class_no, number=student_number)
            .order_by(User.id.desc())
            .first()
        )
    if not user:
        user = User()
        db.session.add(user)
    user.email = email or user.email
    # 이름은 저장하지 않음 (개인정보 최소화)
    if user.name:
        user.name = ""
    user.type = _coerce_user_type(data.get("type"))
    if grade is not None:
        user.grade = grade
    if class_no is not None:
        user.class_no = class_no
    if student_number is not None:
        user.number = student_number
    db.session.commit()
    return user


def _get_terms_consent(user_id: int | None) -> TermsConsent | None:
    if not user_id:
        return None
    return TermsConsent.query.filter_by(user_id=user_id).first()


def _requires_terms_consent(user: User | None) -> bool:
    if not user:
        return True
    consent = _get_terms_consent(user.id)
    return not consent or consent.version != SERVICE_TERMS_VERSION


def _finalize_login(user: User, remember: bool) -> Response:
    issue_session(user)
    redirect_target = session.pop("post_login_redirect", "/user.html")

    # 기본 서비스 약관 동의 체크
    if _requires_terms_consent(user):
        session["post_terms_redirect"] = redirect_target
        return make_response(redirect("/terms-consent.html"))

    response = make_response(redirect(redirect_target))
    clear_remembered_session(response)
    if remember:
        persist_remembered_session(user, response, device_info=request.headers.get("User-Agent"))
    return response


@blueprint.get("/login")
def login() -> Response:
    remember = str(request.args.get("remember", "1")).lower() not in {"0", "false", "off"}
    next_url = request.args.get("next")
    if next_url:
        session["post_login_redirect"] = next_url
    session["remember_me_requested"] = remember
    if not config.USE_DIMICHECK_OAUTH:
        return redirect(_build_legacy_login_url())
    state = secrets.token_urlsafe(32)
    session["google_oauth_state"] = state
    return redirect(build_google_auth_url(state))


@blueprint.get("/callback")
def callback() -> Response:
    if not config.USE_DIMICHECK_OAUTH:
        return _handle_legacy_callback()
    state = request.args.get("state")
    expected_state = session.pop("google_oauth_state", None)
    if not state or state != expected_state:
        return jsonify({"error": {"code": "invalid_state", "message": "state mismatch"}}), 400
    code = request.args.get("code")
    if not code:
        return jsonify({"error": {"code": "invalid_request", "message": "code missing"}}), 400
    try:
        token_payload = exchange_code_for_tokens(code)
        id_info = verify_google_id_token(token_payload.get("id_token"))
    except Exception as exc:  # pylint: disable=broad-except
        return jsonify({"error": {"code": "invalid_token", "message": str(exc)}}), 400
    email = id_info.get("email")
    if not email or not email.endswith("@dimigo.hs.kr"):
        return jsonify({"error": {"code": "unauthorized", "message": "dimigo email required"}}), 403
    remember = bool(session.get("remember_me_requested"))
    user = User.query.filter_by(email=email).first()
    if user and (user.grade is None or user.class_no is None or user.number is None):
        user = None
    if user:
        # 이름은 저장하지 않음
        if user.name:
            user.name = ""
            db.session.commit()
        session.pop("remember_me_requested", None)
        return _finalize_login(user, remember)
    session["pending_registration"] = {
        "email": email,
        "name": "",
    }
    return redirect(url_for("auth.register_form"))


def _handle_legacy_callback() -> Response:
    token = request.args.get("token")
    if not token:
        return jsonify({"error": {"code": "invalid_token", "message": "token missing"}}), 400
    try:
        public_key = _get_legacy_public_key()
        payload = jose_jwt.decode(token, public_key, algorithms=["RS256"])
        user_data = payload.get("data", {})
    except JWTError as exc:
        return jsonify({"error": {"code": "invalid_token", "message": str(exc)}}), 400
    _normalize_student_payload(user_data)
    user = _ensure_user_record(user_data)
    remember = bool(session.pop("remember_me_requested", False))
    return _finalize_login(user, remember)


@blueprint.route("/logout", methods=["GET", "POST"])
def logout() -> Response:
    session.clear()
    response = make_response(redirect("/login.html"))
    clear_remembered_session(response)
    return response


@blueprint.get("/register")
def register_form():
    if not config.USE_DIMICHECK_OAUTH:
        return redirect("/login.html")
    pending = session.get("pending_registration")
    if not pending:
        return redirect("/login.html")
    return render_template("register.html", pending=pending, error=None)


@blueprint.post("/register")
def register_submit():
    if not config.USE_DIMICHECK_OAUTH:
        return redirect("/login.html")
    pending = session.get("pending_registration")
    if not pending:
        return redirect("/login.html")
    if request.form.get("privacy_agree") not in {"on", "true", "1"}:
        return (
            render_template(
                "register.html",
                pending=pending,
                error="개인정보 처리방침에 동의해야 가입할 수 있습니다.",
            ),
            400,
        )
    try:
        grade = int(request.form.get("grade", "").strip())
        class_no = int(request.form.get("class", "").strip())
        number = int(request.form.get("number", "").strip())
    except ValueError:
        return (
            render_template(
                "register.html",
                pending=pending,
                error="학번(학년/반/번호)을 모두 입력하세요.",
            ),
            400,
        )
    if grade <= 0 or class_no <= 0 or number <= 0:
        return (
            render_template(
                "register.html",
                pending=pending,
                error="학번 값이 올바르지 않습니다.",
            ),
            400,
        )
    name = request.form.get("name", "").strip() or pending.get("name") or ""
    email = pending["email"]
    user = User.query.filter_by(email=email).first()
    if not user:
        user = User(email=email)
        db.session.add(user)
    # 이름은 저장하지 않음 (개인정보 최소화)
    user.name = ""
    user.type = UserType.STUDENT
    user.grade = grade
    user.class_no = class_no
    user.number = number
    user.last_profile_update = datetime.utcnow()
    db.session.commit()
    session.pop("pending_registration", None)
    remember = bool(session.pop("remember_me_requested", False))
    return _finalize_login(user, remember)


@blueprint.get("/status")
def status():
    user = session.get("user")
    if not user:
        return jsonify({"logged_in": False}), 401
    # Check terms consent requirement
    db_user = User.query.get(user.get("id")) if user.get("id") else None
    requires_terms = _requires_terms_consent(db_user)
    return jsonify(
        {
            "logged_in": True,
            "role": user.get("type"),
            "grade": user.get("grade"),
            "section": user.get("section"),
            "number": user.get("number"),
            "email": user.get("email"),
            "requires_terms_consent": requires_terms,
            "terms_version": SERVICE_TERMS_VERSION,
        }
    )


@blueprint.get("/mode")
def mode():
    return jsonify({"use_dimicheck_oauth": config.USE_DIMICHECK_OAUTH})


@blueprint.get("/terms-consent")
def get_terms_consent():
    user_info = session.get("user")
    if not user_info:
        return jsonify({"error": "unauthorized"}), 401
    db_user = User.query.get(user_info.get("id")) if user_info.get("id") else None
    if not db_user:
        return jsonify({"error": "unauthorized"}), 401
    consent = _get_terms_consent(db_user.id)
    if consent and consent.version == SERVICE_TERMS_VERSION:
        return jsonify({
            "consented": True,
            "version": consent.version,
            "agreedAt": consent.agreed_at.isoformat() if consent.agreed_at else None,
            "redirect": session.get("post_terms_redirect"),
        })
    return jsonify({
        "consented": False,
        "version": consent.version if consent else None,
        "requiredVersion": SERVICE_TERMS_VERSION,
        "redirect": session.get("post_terms_redirect"),
    })


@blueprint.post("/terms-consent")
def accept_terms_consent():
    user_info = session.get("user")
    if not user_info:
        return jsonify({"error": "unauthorized"}), 401
    db_user = User.query.get(user_info.get("id")) if user_info.get("id") else None
    if not db_user:
        return jsonify({"error": "unauthorized"}), 401

    payload = request.get_json(silent=True) or {}
    version = payload.get("version") or SERVICE_TERMS_VERSION
    if version != SERVICE_TERMS_VERSION:
        version = SERVICE_TERMS_VERSION

    consent = _get_terms_consent(db_user.id)
    now = datetime.utcnow()
    if consent:
        consent.version = version
        consent.agreed_at = now
    else:
        consent = TermsConsent(user_id=db_user.id, version=version, agreed_at=now)
        db.session.add(consent)
    db.session.commit()

    redirect_target = session.pop("post_terms_redirect", "/user.html")
    return jsonify({
        "ok": True,
        "consented": True,
        "version": version,
        "agreedAt": consent.agreed_at.isoformat() if consent.agreed_at else None,
        "redirect": redirect_target,
    })

@blueprint.get("/dev-login")
def dev_login():
    if not config.ENABLE_DEV_LOGIN:
        return ("", 404)
    role = request.args.get("role", "student").lower()
    grade = _coerce_int(request.args.get("grade")) or 1
    class_no = _coerce_int(request.args.get("class")) or 1
    number = _coerce_int(request.args.get("number")) or 1
    email = f"dev-{role}@example.com"
    user = User.query.filter_by(email=email).first()
    if not user:
        user = User(email=email)
        db.session.add(user)
    user.name = ""
    try:
        user.type = UserType(role)
    except ValueError:
        user.type = UserType.STUDENT
    user.grade = grade
    user.class_no = class_no
    user.number = number
    db.session.commit()
    remember = bool(request.args.get("remember", "1") not in {"0", "false"})
    response = _finalize_login(user, remember)
    return response
