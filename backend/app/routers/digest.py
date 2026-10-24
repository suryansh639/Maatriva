"""AMBER digest for the ANM (Requirements 25.1, 25.2; design §9, §13).

Both routes are doctor and ANM only, scoped to the caller's facility.

- ``GET /api/digest``: the facility's open AMBER (ANM-recipient) alerts created
  in the last ``DIGEST_WINDOW_DAYS`` days, grouped by village (villages by name,
  items newest first), each with the reasons of the mother's active flags for
  the alert's codes (falling back to the alert summary).
- ``POST /api/digest/send``: one writing transaction (``begin_write`` first)
  that writes one ``amber_digest`` mock SMS per ANM of the facility, with counts
  per village only (no names). Returns ``{"count": rows_written}``; a facility
  with no ANM writes nothing and returns 0.

Logs reference ids only (Req 46.4).
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any, Dict, List, Tuple

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import db, notifications
from app.deps import CurrentUser, get_current_user, require_roles
from app.models import (
    Alert,
    AlertRecipientRole,
    AlertSeverity,
    AlertStatus,
    Mother,
    NotificationKind,
    RiskFlag,
    Role,
    User,
    Village,
)
from app.timeutil import iso_z, utcnow

log = logging.getLogger(__name__)

DIGEST_WINDOW_DAYS = 7

router = APIRouter(
    prefix="/api/digest",
    tags=["digest"],
    dependencies=[Depends(get_current_user)],
)


def build_digest(session: Session, facility_id: str, now: datetime) -> Dict[str, Any]:
    """Open AMBER alerts of ``facility_id`` created since ``now - 7 days``,
    grouped by village."""
    since = now - timedelta(days=DIGEST_WINDOW_DAYS)
    rows = session.execute(
        select(Alert, Mother, Village)
        .join(Mother, Mother.id == Alert.mother_id)
        .join(Village, Village.id == Mother.village_id)
        .where(
            Alert.facility_id == facility_id,
            Mother.facility_id == facility_id,
            Alert.severity == AlertSeverity.AMBER.value,
            Alert.recipient_role == AlertRecipientRole.anm.value,
            Alert.status == AlertStatus.open.value,
            Alert.created_at >= since,
        )
        .order_by(Village.name, Village.id, Alert.created_at.desc(), Alert.id.desc())
    ).all()

    mother_ids = {m.id for _a, m, _v in rows}
    reasons_by_mother: Dict[str, Dict[str, str]] = {}
    if mother_ids:
        for mother_id, code, reason in session.execute(
            select(RiskFlag.mother_id, RiskFlag.code, RiskFlag.reason).where(
                RiskFlag.mother_id.in_(mother_ids), RiskFlag.active.is_(True)
            )
        ).all():
            reasons_by_mother.setdefault(mother_id, {})[code] = reason

    groups: Dict[str, Dict[str, Any]] = {}
    for alert, mother, village in rows:
        group = groups.get(village.id)
        if group is None:
            group = {"village_id": village.id, "village_name": village.name, "count": 0, "items": []}
            groups[village.id] = group
        by_code = reasons_by_mother.get(mother.id, {})
        reasons = [by_code[c] for c in alert.codes if c in by_code] or [alert.summary]
        group["items"].append(
            {
                "alert_id": alert.id,
                "mother_id": mother.id,
                "mother_name": mother.full_name,
                "short_code": notifications.short_code(mother.id),
                "risk_level": mother.risk_level,
                "flag_codes": alert.codes,
                "reasons": reasons,
                "summary": alert.summary,
                "created_at": iso_z(alert.created_at),
                "updated_at": iso_z(alert.updated_at),
            }
        )
        group["count"] += 1

    villages = list(groups.values())  # insertion order = village name order
    return {
        "as_of": iso_z(now),
        "since": iso_z(since),
        "total": sum(g["count"] for g in villages),
        "villages": villages,
    }


@router.get("")
def get_digest(
    user: CurrentUser = require_roles("doctor", "anm"),
    session: Session = Depends(db.get_db),
) -> Dict[str, Any]:
    return build_digest(session, user.facility_id, utcnow())


@router.post("/send")
def send_digest(
    user: CurrentUser = require_roles("doctor", "anm"),
    session: Session = Depends(db.get_db),
) -> Dict[str, int]:
    db.begin_write(session)  # first statement: global write lock (Req 3.6)
    now = utcnow()
    digest = build_digest(session, user.facility_id, now)
    counts: List[Tuple[str, int]] = [(g["village_name"], g["count"]) for g in digest["villages"]]
    body = notifications.amber_digest_body(counts)
    anms = (
        session.execute(
            select(User)
            .where(User.role == Role.anm.value, User.facility_id == user.facility_id)
            .order_by(User.username)
        )
        .scalars()
        .all()
    )
    for anm in anms:
        notifications.write(
            session, NotificationKind.amber_digest, user.facility_id, anm, body, now=now
        )
    session.commit()
    if not anms:
        log.warning("digest send: facility %s has no ANM, no SMS written", user.facility_id)
    log.info(
        "digest sent by user %s: %d SMS, %d alerts", user.id, len(anms), digest["total"]
    )
    return {"count": len(anms)}


__all__ = ["router", "build_digest", "DIGEST_WINDOW_DAYS"]
