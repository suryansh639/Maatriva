"""Demo helpers under ``/api/demo`` (Requirements 40.1–40.4; design §14).

Doctor and admin only. When ``MAATRIVA_DEMO != 1`` the router stays mounted but
its first dependency raises 404 ``NOT_FOUND`` for every path (Req 40.2), before
authentication runs. A doctor only reaches the demo mother of their own facility
(404 otherwise); an admin has no facility and is not scoped here (Req 6.2).

- ``POST /api/demo/trigger-red``: one ``begin_write`` transaction closes the demo
  mother's live alerts, bulk-deletes her ``demo-trigger`` visits (rotating the
  epoch when any were deleted, since pulls carry no deletes) and inserts a visit
  dated today with her latest non-trigger weight − 1.4 kg and Hb 6.8. After the
  commit ``apply_triage`` runs; the new visit is the source of ``HB_SEVERE`` and
  ``WEIGHT_LOSS`` and there is no live RED alert, so every press creates exactly
  one fresh RED alert (Req 16.1). Returns ``alert_id``, ``mother_id``,
  ``risk_level``.
- ``POST /api/demo/reset``: one ``begin_write`` transaction bulk-deletes every
  non-seed visit of the demo mother, closes her alerts, cancels her open tasks,
  deletes her birth outcome, restores her profile and re-dates her seed history
  from ``demo_data.build_demo_mother_history(today)`` (re-inserting missing seed
  visits), and rotates the epoch. ``apply_triage`` then makes her GREEN. Returns
  ``mother_id``, ``risk_level``.

Visit deletes are bulk ``DELETE`` statements so ``RiskFlag.source_visit_id``
(``ON DELETE SET NULL``) keeps the flag history. Alerts and tasks are closed or
cancelled, never deleted. Events are published only after the commits
(Req 18.6). Logs carry ids only (Req 46.4).
"""
from __future__ import annotations

import logging
from datetime import date, datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app import alert_router, db, demo_data
from app.alert_router import Event
from app.config import get_settings
from app.deps import CurrentUser, get_current_user, require_roles
from app.errors import DomainError, not_found
from app.gestation import edd_naegele
from app.models import (
    Alert,
    AlertSeverity,
    AlertStatus,
    BirthOutcome,
    Mother,
    MotherStatus,
    Task,
    TaskStatus,
    Village,
    Visit,
    new_uuid,
)
from app.routers.mothers import publish_events
from app.timeutil import ist_date, utcnow
from app.triage_service import apply_triage

log = logging.getLogger(__name__)


def require_demo_enabled() -> None:
    """404 for every ``/api/demo/*`` path unless ``MAATRIVA_DEMO=1`` (Req 40.2)."""
    if not get_settings().demo:
        raise not_found()


router = APIRouter(
    prefix="/api/demo",
    tags=["demo"],
    # Order matters: the demo check runs before authentication.
    dependencies=[Depends(require_demo_enabled), Depends(get_current_user)],
)

MOTHER_INACTIVE = "MOTHER_INACTIVE"


# --------------------------------------------------------------------------- helpers


def _demo_mother(session: Session, user: CurrentUser) -> Mother:
    """The demo mother under the write lock; 404 when absent or, for a doctor,
    outside the doctor's facility."""
    mother = session.get(Mother, demo_data.DEMO_MOTHER_ID, populate_existing=True)
    if mother is None or (user.role == "doctor" and mother.facility_id != user.facility_id):
        raise not_found()
    return mother


def _close_alerts(session: Session, mother_id: str, statuses, now: datetime) -> List[Alert]:
    """Close the mother's alerts whose status is in ``statuses``; returns them."""
    alerts = list(
        session.execute(
            select(Alert).where(Alert.mother_id == mother_id, Alert.status.in_(list(statuses)))
        )
        .scalars()
        .all()
    )
    for alert in alerts:
        alert.status = AlertStatus.closed.value
        alert.closed_at = now
        alert.updated_at = now
    return alerts


def _closed_events(session: Session, alerts: List[Alert]) -> List[Event]:
    """``alert.updated`` for closed RED alerts (AMBER alerts are never published)."""
    return [
        alert_router.updated_event(a, (), session=session)
        for a in alerts
        if a.severity == AlertSeverity.RED.value
    ]


def _latest_weight(session: Session, mother: Mother) -> Optional[float]:
    """Weight of the latest weighed non-trigger visit, else ``first_weight_kg``."""
    row = session.execute(
        select(Visit.weight_kg)
        .where(
            Visit.mother_id == mother.id,
            Visit.weight_kg.is_not(None),
            (Visit.device_id.is_(None)) | (Visit.device_id != demo_data.DEMO_TRIGGER_DEVICE_ID),
        )
        .order_by(Visit.visit_date.desc(), Visit.client_created_at.desc())
        .limit(1)
    ).scalar_one_or_none()
    return row if row is not None else mother.first_weight_kg


def _restore_seed_visit(
    session: Session, mother: Mother, dv: demo_data.DemoVisit, seq: int
) -> None:
    visit = session.get(Visit, dv.id, populate_existing=True)
    if visit is None:
        visit = Visit(
            id=dv.id,
            mother_id=mother.id,
            recorded_by_id=mother.asha_id,
            device_id=demo_data.DEMO_SEED_DEVICE_ID,
        )
        session.add(visit)
    visit.visit_date = dv.visit_date
    visit.weight_kg = dv.weight_kg
    visit.weight_source = dv.weight_source
    visit.ble_raw_hex = None
    visit.hb_gdl = dv.hb_gdl
    visit.hb_source = "manual"
    visit.bp_systolic = dv.bp_systolic
    visit.bp_diastolic = dv.bp_diastolic
    visit.bp_source = "manual"
    visit.ifa_tablets = dv.ifa_tablets
    visit.calcium_tablets = dv.calcium_tablets
    visit.thr_received = True
    visit.notes = None
    visit.client_created_at = dv.client_created_at
    visit.received_at = demo_data.ist_at(dv.visit_date, 18)
    visit.change_seq = seq


def _restore_profile(session: Session, mother: Mother, hist: demo_data.DemoHistory, seq: int) -> None:
    mother.full_name = demo_data.DEMO_MOTHER_NAME
    mother.guardian_name = demo_data.DEMO_GUARDIAN_NAME
    mother.age = demo_data.DEMO_MOTHER_AGE
    mother.phone = None
    mother.is_bpl = False
    village_id = session.execute(
        select(Village.id).where(
            Village.facility_id == mother.facility_id,
            Village.name == demo_data.DEMO_VILLAGE_NAME,
        )
    ).scalar_one_or_none()
    if village_id is not None:
        mother.village_id = village_id
    mother.lmp_date = hist.lmp_date
    mother.edd_date = edd_naegele(hist.lmp_date)
    mother.registered_at = hist.registered_at
    mother.updated_at = hist.registered_at
    mother.height_cm = hist.height_cm
    mother.first_weight_kg = hist.first_weight_kg
    mother.status = MotherStatus.active.value
    mother.change_seq = seq


# --------------------------------------------------------------------------- routes


@router.post("/trigger-red")
def trigger_red(
    user: CurrentUser = require_roles("doctor", "admin"),
    session: Session = Depends(db.get_db),
) -> Dict[str, Any]:
    now = utcnow()
    today: date = ist_date(now)
    try:
        seq = db.begin_write(session)  # first statement (Req 3.6)
        mother = _demo_mother(session, user)
        if mother.status != MotherStatus.active.value:
            raise DomainError(409, MOTHER_INACTIVE, "Demo mother is delivered; call /api/demo/reset")

        closed = _close_alerts(session, mother.id, alert_router.LIVE_RED, now)
        deleted = session.execute(
            delete(Visit).where(
                Visit.mother_id == mother.id,
                Visit.device_id == demo_data.DEMO_TRIGGER_DEVICE_ID,
            )
        ).rowcount
        if deleted:
            db.rotate_epoch(session)  # pulls carry no deletes

        base = _latest_weight(session, mother)
        weight = (
            round(base - demo_data.DEMO_TRIGGER_WEIGHT_DROP_KG, 2) if base is not None else None
        )
        visit = Visit(
            id=new_uuid(),
            mother_id=mother.id,
            visit_date=today,
            weight_kg=weight,
            weight_source="simulated" if weight is not None else None,
            hb_gdl=demo_data.DEMO_TRIGGER_HB,
            hb_source="manual",
            recorded_by_id=user.id,
            device_id=demo_data.DEMO_TRIGGER_DEVICE_ID,
            client_created_at=now,
            received_at=now,
            change_seq=seq,
        )
        session.add(visit)
        session.commit()
    except Exception:
        session.rollback()
        raise
    events = _closed_events(session, closed)
    session.rollback()  # end the read before apply_triage takes the write lock
    log.info(
        "demo trigger-red by user %s: visit %s, %d alerts closed, %d trigger visits deleted",
        user.id, visit.id, len(closed), deleted or 0,
    )

    outcome = apply_triage(session, mother.id, now)
    live = alert_router.find_alert(
        session, mother.id, AlertSeverity.RED.value, alert_router.LIVE_RED
    )
    alert_id = live.id if live is not None else None
    session.rollback()
    publish_events(events + outcome.events)
    return {"alert_id": alert_id, "mother_id": mother.id, "risk_level": outcome.risk_level}


@router.post("/reset")
def reset(
    user: CurrentUser = require_roles("doctor", "admin"),
    session: Session = Depends(db.get_db),
) -> Dict[str, Any]:
    now = utcnow()
    today: date = ist_date(now)
    try:
        seq = db.begin_write(session)  # first statement (Req 3.6)
        mother = _demo_mother(session, user)

        deleted = session.execute(
            delete(Visit).where(
                Visit.mother_id == mother.id,
                Visit.id.not_in(demo_data.DEMO_VISIT_IDS),
            )
        ).rowcount
        closed = _close_alerts(
            session,
            mother.id,
            [s.value for s in AlertStatus if s != AlertStatus.closed],
            now,
        )
        tasks = list(
            session.execute(
                select(Task).where(
                    Task.mother_id == mother.id, Task.status == TaskStatus.open.value
                )
            )
            .scalars()
            .all()
        )
        for task in tasks:
            task.status = TaskStatus.cancelled.value
            task.change_seq = seq
        session.execute(delete(BirthOutcome).where(BirthOutcome.mother_id == mother.id))

        hist = demo_data.build_demo_mother_history(today)
        _restore_profile(session, mother, hist, seq)
        for dv in hist.visits:
            _restore_seed_visit(session, mother, dv, seq)
        db.rotate_epoch(session)  # seed visits re-dated, other visits deleted
        session.commit()
    except Exception:
        session.rollback()
        raise
    events = _closed_events(session, closed)
    session.rollback()  # end the read before apply_triage takes the write lock
    log.info(
        "demo reset by user %s: %d visits deleted, %d alerts closed, %d tasks cancelled",
        user.id, deleted or 0, len(closed), len(tasks),
    )

    outcome = apply_triage(session, mother.id, now)
    publish_events(events + outcome.events)
    return {"mother_id": mother.id, "risk_level": outcome.risk_level}


__all__ = ["router", "require_demo_enabled"]
