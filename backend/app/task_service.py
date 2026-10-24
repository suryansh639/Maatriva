"""Doctor actions → ASHA tasks (Requirements 17.2, 23.2–23.7; design §13).

``create_task`` is one writing transaction that starts with ``db.begin_write``
(Req 3.6) and commits before returning. It never publishes: it returns the
events as ``(facility_id, event_name, payload)`` tuples for the caller to publish
after the commit (Req 18.6). The router and the seed both use it.

Order of checks:
1. ``due_date`` within today..today + 60 (IST of ``now``): pure, before the lock;
   422 ``VALIDATION_ERROR``.
2. Mother in the caller's scope, else 404 ``NOT_FOUND`` (Req 6.3).
3. Mother ``delivered`` → 409 ``MOTHER_INACTIVE`` (Req 23.4).
4. A supplied ``alert_id`` must be a live RED (doctor) alert of this mother;
   another mother's, a closed, an AMBER or an unknown alert → 422
   ``INVALID_ALERT`` (Req 23.5). Without ``alert_id`` the task auto-links to the
   mother's live RED alert, if any (Req 23.6).

Effects: an ``open`` task with ``asha_id`` copied from the mother and the
transaction's Change_Seq (Req 23.2); a linked alert is set ``actioned``
(Req 23.7) and yields ``alert.updated`` with ``new_codes=[]``; one
``task_assigned`` mock SMS goes to the mother's ASHA (Req 17.2).

Logs carry ids only (Req 46.4).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import List, Optional

from sqlalchemy.orm import Session

from app import alert_router, db, notifications
from app.alert_router import Event
from app.deps import CurrentUser, get_mother_in_scope
from app.errors import DomainError
from app.models import (
    Alert,
    AlertSeverity,
    AlertStatus,
    Mother,
    MotherStatus,
    NotificationKind,
    Task,
    TaskStatus,
    User,
    new_uuid,
)
from app.schemas import TASK_DUE_MAX_DAYS, TaskCreateIn
from app.timeutil import ist_date

log = logging.getLogger(__name__)

VALIDATION_ERROR = "VALIDATION_ERROR"
MOTHER_INACTIVE = "MOTHER_INACTIVE"
INVALID_ALERT = "INVALID_ALERT"


@dataclass
class TaskCreateOutcome:
    task: Task
    alert: Optional[Alert]
    events: List[Event] = field(default_factory=list)


def check_due_date(due: date, today: date) -> None:
    """422 ``VALIDATION_ERROR`` unless ``today <= due <= today + 60`` (Req 23.3)."""
    if not today <= due <= today + timedelta(days=TASK_DUE_MAX_DAYS):
        raise DomainError(
            422,
            VALIDATION_ERROR,
            f"due_date: must be from today to today + {TASK_DUE_MAX_DAYS} days",
        )


def _invalid_alert(message: str) -> DomainError:
    return DomainError(422, INVALID_ALERT, message)


def _resolve_alert(session: Session, mother: Mother, alert_id: Optional[str]) -> Optional[Alert]:
    """The alert to link: the supplied one (validated) or the live RED alert."""
    if alert_id is None:
        return alert_router.find_alert(
            session, mother.id, AlertSeverity.RED.value, alert_router.LIVE_RED
        )
    alert = session.get(Alert, alert_id)
    if alert is None or alert.mother_id != mother.id:
        raise _invalid_alert("alert_id does not belong to this mother")
    if alert.severity != AlertSeverity.RED.value or alert.status not in alert_router.LIVE_RED:
        raise _invalid_alert("alert_id must be an open RED alert of this mother")
    return alert


def create_task(
    session: Session,
    user: CurrentUser,
    mother_id: str,
    data: TaskCreateIn,
    now: datetime,
    *,
    task_id: Optional[str] = None,
) -> TaskCreateOutcome:
    """Create a task for ``mother_id`` issued by ``user`` at ``now`` (naive UTC).

    Commits on success; rolls back and re-raises ``DomainError`` otherwise.
    ``task_id`` lets the seed supply deterministic ids.
    """
    today = ist_date(now)
    check_due_date(data.due_date, today)  # pure: before the write lock

    seq = db.begin_write(session)  # first statement (Req 3.6)
    try:
        mother = get_mother_in_scope(session, user, mother_id)
        if mother.status == MotherStatus.delivered.value:
            raise DomainError(409, MOTHER_INACTIVE, "Mother is delivered; no new tasks")
        alert = _resolve_alert(session, mother, data.alert_id)

        task = Task(
            id=task_id or new_uuid(),
            mother_id=mother.id,
            alert_id=alert.id if alert is not None else None,
            issued_by_id=user.id,
            asha_id=mother.asha_id,
            action_type=data.action_type,
            instructions=data.instructions,
            due_date=data.due_date,
            status=TaskStatus.open.value,
            created_at=now,
            change_seq=seq,
        )
        session.add(task)

        if alert is not None:
            alert.status = AlertStatus.actioned.value
            alert.updated_at = now

        asha = session.get(User, mother.asha_id)
        notifications.write(
            session,
            NotificationKind.task_assigned,
            mother.facility_id,
            asha,
            notifications.task_assigned_body(task.action_type, mother.id, task.due_date),
            related_alert_id=task.alert_id,
            related_task_id=task.id,
            now=now,
        )
        session.commit()
    except Exception:
        session.rollback()
        raise

    log.info(
        "task %s created for mother %s by user %s (alert %s)",
        task.id,
        mother.id,
        user.id,
        task.alert_id,
    )
    events: List[Event] = []
    if alert is not None:
        # Status-only change (actioned): new_codes is empty, so no doctor toast.
        events.append(alert_router.updated_event(alert, (), mother=mother, session=session))
    return TaskCreateOutcome(task=task, alert=alert, events=events)


__all__ = [
    "VALIDATION_ERROR",
    "MOTHER_INACTIVE",
    "INVALID_ALERT",
    "TaskCreateOutcome",
    "check_due_date",
    "create_task",
]
