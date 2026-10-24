"""Birth outcomes and outcome metrics (Requirements 3.11, 16.10, 24.1–24.4,
24.6, 24.7; design §11, §13).

``record`` is one writing transaction that starts with ``db.begin_write``
(Req 3.6) and commits before returning. Like ``task_service.create_task`` it never
publishes: it returns events as ``(facility_id, event_name, payload)`` tuples for
the caller to publish after the commit (Req 18.6). The router and the seed both
use it.

Order of checks:
1. ``delivery_date`` after today (IST of ``now``): pure, before the lock; 422
   ``VALIDATION_ERROR``. Weight rules are in ``BirthOutcomeIn`` (FastAPI 422).
2. Mother in the caller's scope, else 404 ``NOT_FOUND`` (Req 6.3).
3. An existing BirthOutcome → 409 ``ALREADY_RECORDED`` (Req 24.4); a delivered
   mother without one → 409 ``MOTHER_INACTIVE``.
4. ``delivery_date`` before LMP + 140 days → 422 ``VALIDATION_ERROR`` (Req 24.2).

Effects (Req 16.10, 24.1), all with the transaction's Change_Seq where syncable:
- the mother becomes ``delivered`` (new ``change_seq``); her risk level becomes
  GREEN, the worst severity of no active flags (Req 15.6), and ``risk_updated_at``
  moves when the level changed or a flag was resolved;
- every active flag is resolved (``active=False``, ``resolved_at``);
- every non-closed alert (live RED and open AMBER) is closed;
- every open task is ``cancelled`` with the new ``change_seq``, so ASHA pulls
  deliver the cancellation;
- a BirthOutcome is inserted; ``is_lbw`` is computed by the model (Req 3.11).

Events: ``alert.updated`` (``new_codes=[]``) per closed RED alert (AMBER alerts
are never published) and ``risk.changed`` when the level changed.

``hb_improved`` is the pure "Hb improved after action" rule (Req 24.7) and
``metrics`` builds the five ``GET /api/outcomes`` counts (Req 24.6).

Logs carry ids only (Req 46.4).
"""
from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional, Sequence, Tuple

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import alert_router, db
from app.alert_router import Event
from app.deps import CurrentUser, get_mother_in_scope, mother_scope_filter
from app.errors import DomainError
from app.models import (
    Alert,
    AlertSeverity,
    AlertStatus,
    BirthOutcome,
    BirthOutcomeKind,
    Mother,
    MotherStatus,
    RiskFlag,
    RiskLevel,
    Task,
    TaskStatus,
    Visit,
    new_uuid,
)
from app.schemas import DELIVERY_MIN_GA_DAYS, BirthOutcomeIn, OutcomesOut
from app.timeutil import ist_date

log = logging.getLogger(__name__)

VALIDATION_ERROR = "VALIDATION_ERROR"
MOTHER_INACTIVE = "MOTHER_INACTIVE"
ALREADY_RECORDED = "ALREADY_RECORDED"

# Req 24.7: latest Hb after the first task minus latest Hb on or before it.
HB_IMPROVED_MIN_DELTA = 0.5
# Hb values are stored at 0.1 g/dL; this absorbs float noise such as
# 7.8 - 7.3 == 0.49999999999999956 without changing any 0.1-grid outcome.
_HB_EPS = 1e-9


@dataclass
class OutcomeRecordOutcome:
    outcome: BirthOutcome
    mother: Mother
    closed_alerts: List[Alert] = field(default_factory=list)
    cancelled_tasks: List[Task] = field(default_factory=list)
    events: List[Event] = field(default_factory=list)


# --------------------------------------------------------------------------- record


def check_delivery_not_future(delivery: date, today: date) -> None:
    """422 ``VALIDATION_ERROR`` when ``delivery`` is after ``today`` (Req 24.2)."""
    if delivery > today:
        raise DomainError(422, VALIDATION_ERROR, "delivery_date: must not be after today")


def check_delivery_after_lmp(delivery: date, lmp: date) -> None:
    """422 ``VALIDATION_ERROR`` when ``delivery`` is before LMP + 140 days (Req 24.2)."""
    if delivery < lmp + timedelta(days=DELIVERY_MIN_GA_DAYS):
        raise DomainError(
            422,
            VALIDATION_ERROR,
            f"delivery_date: must be at least {DELIVERY_MIN_GA_DAYS} days after LMP",
        )


def record(
    session: Session,
    user: CurrentUser,
    mother_id: str,
    data: BirthOutcomeIn,
    now: datetime,
    *,
    outcome_id: Optional[str] = None,
) -> OutcomeRecordOutcome:
    """Record the birth outcome of ``mother_id`` by ``user`` at ``now`` (naive UTC).

    Commits on success; rolls back and re-raises ``DomainError`` otherwise.
    ``outcome_id`` lets the seed supply deterministic ids.
    """
    check_delivery_not_future(data.delivery_date, ist_date(now))  # pure: before the lock

    seq = db.begin_write(session)  # first statement (Req 3.6)
    try:
        mother = get_mother_in_scope(session, user, mother_id)
        existing = session.execute(
            select(BirthOutcome.id).where(BirthOutcome.mother_id == mother.id)
        ).first()
        if existing is not None:
            raise DomainError(409, ALREADY_RECORDED, "Birth outcome already recorded")
        if mother.status == MotherStatus.delivered.value:
            raise DomainError(409, MOTHER_INACTIVE, "Mother is already delivered")
        check_delivery_after_lmp(data.delivery_date, mother.lmp_date)

        # Flags: capture reasons first, so closed-alert payloads keep them.
        active_flags = list(
            session.execute(
                select(RiskFlag).where(
                    RiskFlag.mother_id == mother.id, RiskFlag.active.is_(True)
                )
            )
            .scalars()
            .all()
        )
        reason_by_code: Dict[str, str] = {f.code: f.reason for f in active_flags}
        for flag in active_flags:
            flag.active = False
            flag.resolved_at = now
            flag.last_evaluated_at = now

        # Alerts: close every non-closed one.
        open_alerts = list(
            session.execute(
                select(Alert)
                .where(Alert.mother_id == mother.id, Alert.status != AlertStatus.closed.value)
                .order_by(Alert.created_at, Alert.id)
            )
            .scalars()
            .all()
        )
        for alert in open_alerts:
            alert.status = AlertStatus.closed.value
            alert.closed_at = now
            alert.updated_at = now

        # Tasks: cancel the open ones, with the new Change_Seq for ASHA pulls.
        open_tasks = list(
            session.execute(
                select(Task)
                .where(Task.mother_id == mother.id, Task.status == TaskStatus.open.value)
                .order_by(Task.created_at, Task.id)
            )
            .scalars()
            .all()
        )
        for task in open_tasks:
            task.status = TaskStatus.cancelled.value
            task.change_seq = seq

        # Mother.
        old_level = mother.risk_level
        level_changed = old_level != RiskLevel.GREEN.value
        mother.status = MotherStatus.delivered.value
        mother.risk_level = RiskLevel.GREEN.value
        if level_changed or active_flags:
            mother.risk_updated_at = now
        mother.change_seq = seq

        outcome = BirthOutcome(
            id=outcome_id or new_uuid(),
            mother_id=mother.id,
            delivery_date=data.delivery_date,
            outcome=data.outcome,
            birth_weight_kg=data.birth_weight_kg,
            recorded_by_id=user.id,
            created_at=now,
        )
        session.add(outcome)

        # Payloads are built before the commit, while the closed flags' reasons
        # are still at hand (the flags are no longer active).
        events: List[Event] = []
        for alert in open_alerts:
            if alert.severity == AlertSeverity.RED.value:
                reasons = [reason_by_code[c] for c in alert.codes if c in reason_by_code]
                events.append(
                    alert_router.updated_event(alert, (), mother=mother, reasons=reasons)
                )
        if level_changed:
            events.append(
                (
                    mother.facility_id,
                    "risk.changed",
                    {"mother_id": mother.id, "risk_level": RiskLevel.GREEN.value},
                )
            )
        session.commit()
    except Exception:
        session.rollback()
        raise

    log.info(
        "birth outcome %s recorded for mother %s by user %s (alerts closed %d, tasks cancelled %d)",
        outcome.id,
        mother.id,
        user.id,
        len(open_alerts),
        len(open_tasks),
    )
    return OutcomeRecordOutcome(
        outcome=outcome,
        mother=mother,
        closed_alerts=open_alerts,
        cancelled_tasks=open_tasks,
        events=events,
    )


# --------------------------------------------------------------------------- metrics


def _latest(readings: Sequence[Tuple[date, float]]) -> Optional[float]:
    """Hb of the latest reading by date; among equal dates the last one listed
    (callers pass readings in ``(visit_date, client_created_at)`` order)."""
    if not readings:
        return None
    best_day, best_hb = readings[0]
    for day, hb in readings[1:]:
        if day >= best_day:
            best_day, best_hb = day, hb
    return best_hb


def hb_improved(
    hb_by_date: Sequence[Tuple[date, float]], first_task_day: date
) -> Optional[bool]:
    """Req 24.7. ``None`` when there is no Hb reading on or before
    ``first_task_day`` or none after it; otherwise whether the latest reading after
    minus the latest on or before is at least ``HB_IMPROVED_MIN_DELTA``."""
    before = [(d, hb) for d, hb in hb_by_date if d <= first_task_day]
    after = [(d, hb) for d, hb in hb_by_date if d > first_task_day]
    hb_before = _latest(before)
    hb_after = _latest(after)
    if hb_before is None or hb_after is None:
        return None
    return hb_after - hb_before >= HB_IMPROVED_MIN_DELTA - _HB_EPS


def metrics(session: Session, user: CurrentUser) -> OutcomesOut:
    """The five facility counts of ``GET /api/outcomes`` (Req 24.6), scoped through
    ``deps.mother_scope_filter``. A mother counts towards the Hb metrics when she
    has at least one task (any status); the first task day is the IST date of her
    earliest task's ``created_at``."""
    scope = mother_scope_filter(user)

    first_task_rows = session.execute(
        select(Task.mother_id, func.min(Task.created_at))
        .join(Mother, Mother.id == Task.mother_id)
        .where(scope)
        .group_by(Task.mother_id)
    ).all()
    first_task_day: Dict[str, date] = {mid: ist_date(created) for mid, created in first_task_rows}

    hb_series: Dict[str, List[Tuple[date, float]]] = defaultdict(list)
    if first_task_day:
        hb_rows = session.execute(
            select(Visit.mother_id, Visit.visit_date, Visit.hb_gdl)
            .join(Mother, Mother.id == Visit.mother_id)
            .where(scope, Visit.hb_gdl.is_not(None))
            .order_by(Visit.mother_id, Visit.visit_date, Visit.client_created_at, Visit.id)
        ).all()
        for mid, day, hb in hb_rows:
            if mid in first_task_day:
                hb_series[mid].append((day, hb))

    improved = 0
    with_followup = 0
    for mid, day in first_task_day.items():
        verdict = hb_improved(hb_series.get(mid, []), day)
        if verdict is None:
            continue
        with_followup += 1
        if verdict:
            improved += 1

    births = session.execute(
        select(BirthOutcome.outcome, BirthOutcome.is_lbw)
        .join(Mother, Mother.id == BirthOutcome.mother_id)
        .where(scope)
    ).all()
    return OutcomesOut(
        hb_improved_after_action=improved,
        mothers_with_action_and_followup_hb=with_followup,
        births_recorded=len(births),
        lbw_count=sum(1 for _, lbw in births if lbw),
        live_births=sum(1 for kind, _ in births if kind == BirthOutcomeKind.live_birth.value),
    )


__all__ = [
    "VALIDATION_ERROR",
    "MOTHER_INACTIVE",
    "ALREADY_RECORDED",
    "HB_IMPROVED_MIN_DELTA",
    "OutcomeRecordOutcome",
    "check_delivery_not_future",
    "check_delivery_after_lmp",
    "record",
    "hb_improved",
    "metrics",
]
