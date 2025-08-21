from __future__ import annotations

from io import BytesIO
from typing import Any

from flask import Blueprint, Response, request
from models import PresenceState

blueprint = Blueprint("exports", __name__, url_prefix="/api/exports")


@blueprint.get("/excel")
def export_excel() -> Any:
    from openpyxl import Workbook  # type: ignore

    grade = int(request.args.get("grade", 1))
    class_no = int(request.args.get("class", 1))

    wb = Workbook()
    ws = wb.active
    ws.append(["번호", "상태", "사유"])
    states = PresenceState.query.filter_by(grade=grade, class_no=class_no).order_by(PresenceState.number)
    for s in states:
        ws.append([s.number, s.status.value, s.reason or ""])

    bio = BytesIO()
    wb.save(bio)
    bio.seek(0)
    return Response(
        bio.getvalue(),
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename=export_{grade}_{class_no}.xlsx"},
    )


@blueprint.post("/sheets/daily")
def export_sheets_daily() -> Any:
    import base64

    service_json_b64 = request.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON_B64")
    sheet_id = request.environ.get("GOOGLE_SHEET_ID")
    if not service_json_b64 or not sheet_id:
        return ("", 501)
    creds_json = base64.b64decode(service_json_b64)
    # 실제 구글 API 호출 생략 (stub)
    return ("", 204)

