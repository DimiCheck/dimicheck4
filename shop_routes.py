from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from flask import Blueprint, current_app, jsonify, request, session

from extensions import db
from models import (
    StudentCosmeticEquipment,
    StudentCosmeticItem,
    StudentWallet,
    User,
    WalletTransaction,
)
from utils import is_board_session_active, is_teacher_session_active

blueprint = Blueprint("shop", __name__, url_prefix="/api")

SHOP_SLOTS = {"move_effect", "drag_effect", "aura_effect"}
FREE_ITEM_KEYS = {"none", "move_basic_spark", "drag_soft_trail"}


@dataclass(frozen=True)
class ShopItem:
    key: str
    slot: str
    name: str
    description: str
    price: int
    rarity: str
    preview: str

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "slot": self.slot,
            "name": self.name,
            "description": self.description,
            "price": self.price,
            "rarity": self.rarity,
            "preview": self.preview,
        }


SHOP_CATALOG: tuple[ShopItem, ...] = (
    ShopItem(
        key="move_basic_spark",
        slot="move_effect",
        name="스파크 팝",
        description="도착 순간 자석 주변에 밝은 스파크가 튑니다.",
        price=0,
        rarity="basic",
        preview="spark",
    ),
    ShopItem(
        key="move_stardust",
        slot="move_effect",
        name="스타버스트 착지",
        description="출발점이 터지고, 도착점에 별가루 충격파가 크게 번집니다.",
        price=300,
        rarity="rare",
        preview="starburst",
    ),
    ShopItem(
        key="move_blue_swirl",
        slot="move_effect",
        name="웜홀 소용돌이",
        description="자석이 푸른 포털에 빨려 들어갔다가 반대편에서 튀어나옵니다.",
        price=1200,
        rarity="epic",
        preview="wormhole",
    ),
    ShopItem(
        key="drag_soft_trail",
        slot="drag_effect",
        name="라이트 리본",
        description="드래그 경로를 따라 밝은 리본 잔상이 남습니다.",
        price=0,
        rarity="basic",
        preview="ribbon",
    ),
    ShopItem(
        key="drag_fire_trail",
        slot="drag_effect",
        name="화염 질주",
        description="자석 뒤로 불꽃 꼬리와 작은 폭발이 따라붙습니다.",
        price=500,
        rarity="rare",
        preview="fire",
    ),
    ShopItem(
        key="drag_neon_afterimage",
        slot="drag_effect",
        name="네온 고스트",
        description="선명한 네온 복제 잔상이 여러 겹으로 따라옵니다.",
        price=1500,
        rarity="epic",
        preview="ghost",
    ),
    ShopItem(
        key="aura_soft_glow",
        slot="aura_effect",
        name="아우라 링",
        description="내 자석 주변을 전자칠판에서도 보이는 밝은 링이 감쌉니다.",
        price=800,
        rarity="rare",
        preview="aura",
    ),
)

CATALOG_BY_KEY = {item.key: item for item in SHOP_CATALOG}


def _normalize_int(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


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


def _json_error(message: str, status: int):
    return jsonify({"error": message}), status


def _ensure_shop_tables() -> bool:
    try:
        StudentWallet.__table__.create(bind=db.engine, checkfirst=True)
        WalletTransaction.__table__.create(bind=db.engine, checkfirst=True)
        StudentCosmeticItem.__table__.create(bind=db.engine, checkfirst=True)
        StudentCosmeticEquipment.__table__.create(bind=db.engine, checkfirst=True)
        return True
    except Exception:
        try:
            db.session.rollback()
        except Exception:
            pass
        return False


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


def _get_or_create_equipment(user_id: int, grade: int, section: int, number: int) -> StudentCosmeticEquipment:
    equipment = StudentCosmeticEquipment.query.filter_by(user_id=user_id).first()
    if equipment:
        equipment.grade = grade
        equipment.section = section
        equipment.student_number = number
        return equipment
    equipment = StudentCosmeticEquipment(
        user_id=user_id,
        grade=grade,
        section=section,
        student_number=number,
    )
    db.session.add(equipment)
    db.session.flush()
    return equipment


def _wallet_level(xp: int) -> int:
    return max(1, int(xp // 500) + 1)


def _serialize_equipment(equipment: StudentCosmeticEquipment | None) -> dict[str, str | None]:
    if not equipment:
        return {"move_effect": None, "drag_effect": None, "aura_effect": None}
    return {
        "move_effect": equipment.move_effect,
        "drag_effect": equipment.drag_effect,
        "aura_effect": equipment.aura_effect,
    }


def _serialize_wallet(wallet: StudentWallet) -> dict:
    return {
        "coins": max(0, int(wallet.coins or 0)),
        "xp": max(0, int(wallet.xp or 0)),
        "level": _wallet_level(int(wallet.xp or 0)),
    }


def _load_owned_keys(user_id: int) -> set[str]:
    rows = StudentCosmeticItem.query.filter_by(user_id=user_id).all()
    owned = {str(row.item_key) for row in rows if row.item_key in CATALOG_BY_KEY}
    return owned | FREE_ITEM_KEYS


def _emit_cosmetics_update(
    grade: int,
    section: int,
    student_number: int,
    equipment: StudentCosmeticEquipment | None,
) -> None:
    socketio = current_app.extensions.get("socketio") if current_app else None
    if not socketio:
        return
    socketio.emit(
        "cosmetics_updated",
        {
            "grade": grade,
            "section": section,
            "studentNumber": student_number,
            "equipment": _serialize_equipment(equipment),
        },
        namespace=f"/ws/classes/{grade}/{section}",
    )


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


@blueprint.get("/shop/me")
def get_my_shop_state():
    if not _ensure_shop_tables():
        return _json_error("shop storage unavailable", 503)
    db_user, grade, section, number, error = _require_student_context()
    if error:
        return error

    wallet = _get_or_create_wallet(db_user.id, grade, section, number)
    equipment = _get_or_create_equipment(db_user.id, grade, section, number)
    db.session.commit()

    owned = sorted(_load_owned_keys(db_user.id))
    return jsonify(
        {
            "wallet": _serialize_wallet(wallet),
            "owned": owned,
            "equipment": _serialize_equipment(equipment),
            "catalog": [item.to_dict() for item in SHOP_CATALOG],
        }
    )


@blueprint.post("/shop/buy")
def buy_shop_item():
    if not _ensure_shop_tables():
        return _json_error("shop storage unavailable", 503)
    db_user, grade, section, number, error = _require_student_context()
    if error:
        return error

    payload = request.get_json(silent=True) or {}
    item_key = str(payload.get("itemKey") or "").strip()
    item = CATALOG_BY_KEY.get(item_key)
    if not item:
        return _json_error("invalid item", 400)

    existing = StudentCosmeticItem.query.filter_by(user_id=db_user.id, item_key=item.key).first()
    if existing or item.key in FREE_ITEM_KEYS:
        return _json_error("already owned", 409)

    wallet = _get_or_create_wallet(db_user.id, grade, section, number)
    price = max(0, int(item.price or 0))
    if int(wallet.coins or 0) < price:
        return _json_error("not enough coins", 400)

    wallet.coins = int(wallet.coins or 0) - price
    wallet.updated_at = datetime.utcnow()
    db.session.add(StudentCosmeticItem(user_id=db_user.id, item_key=item.key))
    db.session.add(
        WalletTransaction(
            user_id=db_user.id,
            wallet_id=wallet.id,
            coin_delta=-price,
            xp_delta=0,
            source="shop_purchase",
            source_detail=item.key,
            balance_after=wallet.coins,
        )
    )
    db.session.commit()

    return jsonify(
        {
            "ok": True,
            "wallet": _serialize_wallet(wallet),
            "owned": sorted(_load_owned_keys(db_user.id)),
        }
    )


@blueprint.post("/shop/equip")
def equip_shop_item():
    if not _ensure_shop_tables():
        return _json_error("shop storage unavailable", 503)
    db_user, grade, section, number, error = _require_student_context()
    if error:
        return error

    payload = request.get_json(silent=True) or {}
    slot = str(payload.get("slot") or "").strip()
    item_key_raw = payload.get("itemKey")
    item_key = str(item_key_raw).strip() if item_key_raw is not None else ""
    if slot not in SHOP_SLOTS:
        return _json_error("invalid slot", 400)

    item = None
    if item_key and item_key != "none":
        item = CATALOG_BY_KEY.get(item_key)
        if not item or item.slot != slot:
            return _json_error("invalid item", 400)
        if item.key not in _load_owned_keys(db_user.id):
            return _json_error("item not owned", 403)

    equipment = _get_or_create_equipment(db_user.id, grade, section, number)
    setattr(equipment, slot, item.key if item else None)
    equipment.updated_at = datetime.utcnow()
    db.session.commit()

    _emit_cosmetics_update(grade, section, number, equipment)

    return jsonify({"ok": True, "equipment": _serialize_equipment(equipment)})


@blueprint.get("/classes/cosmetics")
def get_class_cosmetics():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    if grade is None or section is None:
        return _json_error("missing grade/section", 400)
    if not (is_teacher_session_active() or is_board_session_active(grade, section)):
        return _json_error("forbidden", 403)
    if not _ensure_shop_tables():
        return jsonify({"grade": grade, "section": section, "cosmetics": {}})

    rows = StudentCosmeticEquipment.query.filter_by(grade=grade, section=section).all()
    cosmetics: dict[str, dict] = {}
    for row in rows:
        number = _normalize_int(row.student_number)
        if number is None or number < 1 or number > 99:
            continue
        equipment = _serialize_equipment(row)
        if not any(equipment.values()):
            continue
        cosmetics[str(number)] = equipment

    return jsonify({"grade": grade, "section": section, "cosmetics": cosmetics})
