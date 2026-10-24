"""Doctor alert routes and the live SSE stream (Requirements 16.6, 16.7, 18.5,
18.7–18.9, 18.11; design §11–§13).

All routes are doctor only (ANM and ASHA → 403) and scoped to the doctor's
facility. They only see doctor-recipient (RED) alerts; AMBER alerts belong to
the ANM digest, so an AMBER alert id is treated like any out-of-scope id (404).

- ``GET /api/alerts?status=open|all``: ``open`` (default) means live RED
  (``open``/``acknowledged``/``actioned``); ``all`` adds closed ones. Newest first.
- ``POST /api/alerts/{id}/ack``: takes the ``begin_write`` lock, moves
  ``open → acknowledged`` and sets ``acknowledged_at``; any other status is 409
  ``INVALID_STATE``. Publishes ``alert.updated`` (``new_codes=[]``) after commit.
- ``GET /api/alerts/stream``: ``text/event-stream``. Sends ``retry: 3000``, a
  ``hello`` event with ``server_time``, then the facility's broker frames; a
  ``: ping`` comment after ``PING_INTERVAL_S`` idle seconds. Ends when the broker
  enqueues its close marker; the queue is unsubscribed on any exit.

``/stream`` is declared before ``/{alert_id}`` routes so "stream" is never parsed
as an id. Logs carry ids only (Req 46.4).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, AsyncIterator, Dict, List, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app import alert_router, db
from app import events as events_mod
from app.deps import CurrentUser, get_current_user, normalize_id, require_roles
from app.errors import DomainError, not_found
from app.events import format_sse
from app.models import Alert, AlertRecipientRole, AlertStatus, Mother, RiskFlag
from app.timeutil import iso_z, utcnow

log = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/alerts",
    tags=["alerts"],
    dependencies=[Depends(get_current_user)],
)

INVALID_STATE = "INVALID_STATE"

RETRY_MS = 3000
# Idle seconds before a ``: ping`` comment (Req 18.8). Module constant so tests
# can lower it.
PING_INTERVAL_S: float = 15.0

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


# --------------------------------------------------------------------------- helpers


def _alert_query(user: CurrentUser):
    """Doctor-recipient alerts of the caller's facility."""
    return select(Alert).where(
        Alert.facility_id == user.facility_id,
        Alert.recipient_role == AlertRecipientRole.doctor.value,
    )


def _serialize_many(session: Session, alerts: List[Alert]) -> List[Dict[str, Any]]:
    """``AlertOut`` for each alert, loading active-flag reasons in one query."""
    mother_ids = {a.mother_id for a in alerts}
    reasons_by_mother: Dict[str, Dict[str, str]] = {}
    if mother_ids:
        rows = session.execute(
            select(RiskFlag.mother_id, RiskFlag.code, RiskFlag.reason).where(
                RiskFlag.mother_id.in_(mother_ids), RiskFlag.active.is_(True)
            )
        ).all()
        for mother_id, code, reason in rows:
            reasons_by_mother.setdefault(mother_id, {})[code] = reason
    out = []
    for a in alerts:
        by_code = reasons_by_mother.get(a.mother_id, {})
        reasons = [by_code[c] for c in a.codes if c in by_code]
        out.append(alert_router.alert_out(a, reasons=reasons))
    return out


# --------------------------------------------------------------------------- routes


@router.get("")
def list_alerts(
    status: Literal["open", "all"] = Query("open"),
    user: CurrentUser = require_roles("doctor"),
    session: Session = Depends(db.get_db),
) -> List[Dict[str, Any]]:
    stmt = _alert_query(user).options(selectinload(Alert.mother).selectinload(Mother.village))
    if status == "open":
        stmt = stmt.where(Alert.status.in_(alert_router.LIVE_RED))
    stmt = stmt.order_by(Alert.created_at.desc(), Alert.id.desc())
    alerts = list(session.execute(stmt).scalars().all())
    return _serialize_many(session, alerts)


@router.get("/stream")
async def stream(
    request: Request,
    user: CurrentUser = require_roles("doctor"),
) -> StreamingResponse:
    facility_id = user.facility_id
    broker = events_mod.broker

    async def frames() -> AsyncIterator[str]:
        q = broker.subscribe(facility_id)
        log.info("SSE stream opened: user %s facility %s", user.id, facility_id)
        try:
            yield f"retry: {RETRY_MS}\n\n"
            yield format_sse("hello", {"server_time": iso_z(utcnow())})
            while True:
                if await request.is_disconnected():
                    break
                try:
                    item = await asyncio.wait_for(q.get(), PING_INTERVAL_S)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                if item is events_mod._CLOSE:  # noqa: SLF001 - broker's close marker
                    log.info("SSE stream closed by broker: user %s", user.id)
                    break
                yield item
        finally:
            broker.unsubscribe(facility_id, q)
            log.info("SSE stream ended: user %s facility %s", user.id, facility_id)

    return StreamingResponse(frames(), media_type="text/event-stream", headers=SSE_HEADERS)


@router.post("/{alert_id}/ack")
def ack_alert(
    alert_id: str,
    user: CurrentUser = require_roles("doctor"),
    session: Session = Depends(db.get_db),
) -> Dict[str, Any]:
    aid = normalize_id(alert_id)
    if aid is None:
        raise not_found()
    db.begin_write(session)  # first statement: global write lock (Req 3.6)
    alert = session.execute(_alert_query(user).where(Alert.id == aid)).scalar_one_or_none()
    if alert is None:
        session.rollback()
        raise not_found()
    if alert.status != AlertStatus.open.value:
        session.rollback()
        raise DomainError(409, INVALID_STATE, f"Alert is {alert.status}, not open")
    now = utcnow()
    alert.status = AlertStatus.acknowledged.value
    alert.acknowledged_at = now
    alert.updated_at = now
    session.commit()
    log.info("alert %s acknowledged by user %s", alert.id, user.id)

    # After commit (Req 18.6).
    facility_id, name, payload = alert_router.updated_event(alert, (), session=session)
    try:
        events_mod.broker.publish(facility_id, name, payload)
    except Exception:  # best effort; the change is committed
        log.exception("publish failed: event %s facility %s", name, facility_id)
    return payload["alert"]
