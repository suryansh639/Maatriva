"""Per-mother doctor routes under ``/api/mothers`` (design §13).

- ``POST /api/mothers/{id}/tasks`` (doctor): issue an action to the mother's ASHA
  through ``task_service.create_task``; 201 with ``TaskOut`` (Req 23.2–23.7).
- ``POST /api/mothers/{id}/birth-outcome`` (doctor): record the birth through
  ``outcome_service.record``; 201 with ``BirthOutcomeOut`` (Req 24.1–24.4, 16.10).

- ``GET /api/mothers/{id}`` (doctor, ANM): patient detail through
  ``dashboard_service.load_mother_detail`` (Req 22.1).

Every route is authenticated by the
router dependency and scoped through ``deps.get_mother_in_scope`` (404 for absent
and out-of-scope ids alike, Req 6.3). Events are published only after the
service's commit (Req 18.6). Logs carry ids only (Req 46.4).
"""
from __future__ import annotations

import logging
from typing import Iterable

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import dashboard_service, db, outcome_service, task_service
from app import events as events_mod
from app.alert_router import Event
from app.deps import CurrentUser, get_current_user, require_roles
from app.schemas import (
    BirthOutcomeIn,
    BirthOutcomeOut,
    MotherDetailOut,
    TaskCreateIn,
    TaskOut,
)
from app.timeutil import ist_date, today_ist, utcnow

log = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/mothers",
    tags=["mothers"],
    dependencies=[Depends(get_current_user)],
)


def publish_events(events: Iterable[Event]) -> None:
    """Best-effort publish of already-committed events."""
    for facility_id, name, payload in events:
        try:
            events_mod.broker.publish(facility_id, name, payload)
        except Exception:  # the data is committed; never fail the request
            log.exception("publish failed: event %s facility %s", name, facility_id)


# --------------------------------------------------------------------------- tasks


@router.post("/{mother_id}/tasks", status_code=201, response_model=TaskOut)
def create_task(
    mother_id: str,
    body: TaskCreateIn,
    user: CurrentUser = require_roles("doctor"),
    session: Session = Depends(db.get_db),
) -> TaskOut:
    now = utcnow()
    outcome = task_service.create_task(session, user, mother_id, body, now)
    publish_events(outcome.events)
    return TaskOut.from_model(outcome.task, ist_date(now))


# --------------------------------------------------------------------------- birth outcome


@router.post("/{mother_id}/birth-outcome", status_code=201, response_model=BirthOutcomeOut)
def record_birth_outcome(
    mother_id: str,
    body: BirthOutcomeIn,
    user: CurrentUser = require_roles("doctor"),
    session: Session = Depends(db.get_db),
) -> BirthOutcomeOut:
    outcome = outcome_service.record(session, user, mother_id, body, utcnow())
    publish_events(outcome.events)
    return BirthOutcomeOut.model_validate(outcome.outcome)


# --------------------------------------------------------------------------- detail


@router.get("/{mother_id}", response_model=MotherDetailOut)
def get_mother_detail(
    mother_id: str,
    user: CurrentUser = require_roles("doctor", "anm"),
    session: Session = Depends(db.get_db),
) -> MotherDetailOut:
    """Patient detail (Req 22.1): mother, village, ASHA, visits, active flags and
    flag history, tasks, alerts and the birth outcome (or null). 404 for absent
    and out-of-scope ids alike."""
    return dashboard_service.load_mother_detail(session, user, mother_id, today_ist())


__all__ = ["router", "publish_events"]
