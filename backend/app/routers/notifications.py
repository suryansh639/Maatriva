"""Mock SMS log (Requirement 17.4; design §11, §13).

``GET /api/notifications?limit=N`` (doctor, ANM): the caller's facility's
NotificationOutbox rows, newest first (``created_at desc, id desc``). ``limit``
is 1–200 (default 50); out-of-range values are FastAPI's 422. Rows are scoped by
``NotificationOutbox.facility_id == user.facility_id`` (Req 6.1).

Bodies never contain mother names or phones; ``to_phone`` is the recipient
staff user's mock delivery address.
"""
from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import db
from app.deps import CurrentUser, get_current_user, require_roles
from app.models import NotificationOutbox, User
from app.timeutil import iso_z

router = APIRouter(
    prefix="/api/notifications",
    tags=["notifications"],
    dependencies=[Depends(get_current_user)],
)


@router.get("")
def list_notifications(
    limit: int = Query(50, ge=1, le=200),
    user: CurrentUser = require_roles("doctor", "anm"),
    session: Session = Depends(db.get_db),
) -> List[Dict[str, Any]]:
    rows = session.execute(
        select(NotificationOutbox, User.username, User.role)
        .outerjoin(User, User.id == NotificationOutbox.to_user_id)
        .where(NotificationOutbox.facility_id == user.facility_id)
        .order_by(NotificationOutbox.created_at.desc(), NotificationOutbox.id.desc())
        .limit(limit)
    ).all()
    return [
        {
            "id": n.id,
            "channel": n.channel,
            "kind": n.kind,
            "status": n.status,
            "to_user_id": n.to_user_id,
            "to_username": username,
            "to_role": role,
            "to_phone": n.to_phone,
            "body": n.body,
            "related_alert_id": n.related_alert_id,
            "related_task_id": n.related_task_id,
            "created_at": iso_z(n.created_at),
        }
        for n, username, role in rows
    ]


__all__ = ["router"]
