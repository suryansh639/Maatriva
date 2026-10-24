"""Dashboard census, triage queue and patient detail (Requirements 20.1, 21.1–21.3,
22.1; design §13).

Pure functions (no database, no clock):

- ``build_census(facility, villages, mothers, today)``: counts over the *active*
  mothers ("pregnant" means ``status == active``; delivered mothers are
  excluded). Totals, BPL, trimester from GA on ``today``, deliveries due in
  ``today``'s calendar month (by EDD), RED/AMBER/GREEN, and the same counts per
  village with the village coordinates. Every facility village gets a row, even
  with no mothers.
- ``sort_queue(rows, village_id=None, risk=None)``: filters, then orders RED,
  AMBER, GREEN and within a level by ``risk_updated_at`` descending (null last),
  then by name and id so the order is deterministic.

The loaders (``load_census``, ``load_queue_rows``, ``load_mother_detail``) read
the caller's scope through ``deps.mother_scope_filter`` / ``get_mother_in_scope``
and hand plain rows to the pure functions. They never write. ``today`` is the
IST date, supplied by the caller (Req 4.6).
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any, Dict, Iterable, List, Optional, Sequence

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app import alert_router
from app.deps import CurrentUser, get_mother_in_scope, mother_scope_filter
from app.errors import not_found
from app.gestation import ga_days, trimester
from app.models import (
    Alert,
    AlertSeverity,
    Facility,
    Mother,
    MotherStatus,
    RiskLevel,
    Task,
    TaskStatus,
    Village,
    Visit,
)
from app.schemas import (
    BirthOutcomeOut,
    CensusOut,
    CensusVillageOut,
    FacilityRefOut,
    FlagHistoryOut,
    FlagOut,
    MotherDetailOut,
    MotherOut,
    QueueRowOut,
    RiskCountsOut,
    TaskOut,
    TrimesterCountsOut,
    UserRefOut,
    VillageOut,
    VisitOut,
)

RISK_RANK: Dict[str, int] = {
    RiskLevel.RED.value: 0,
    RiskLevel.AMBER.value: 1,
    RiskLevel.GREEN.value: 2,
}
RISK_LEVELS = tuple(RISK_RANK)
_FLAG_SEVERITY_RANK = {"RED": 0, "AMBER": 1, "INFO": 2}


# --------------------------------------------------------------------------- pure: census


def _risk_key(level: str) -> str:
    """``red`` / ``amber`` / ``green``; anything unexpected counts as green."""
    return level.lower() if level in RISK_RANK else "green"


def build_census(
    facility: Any,
    villages: Sequence[Any],
    mothers: Iterable[Any],
    today: date,
) -> CensusOut:
    """Census of the facility's active mothers on ``today`` (IST).

    ``facility`` needs ``id``/``name``; ``villages`` ``id``/``name``/``lat``/``lng``;
    mothers ``village_id``, ``status``, ``is_bpl``, ``lmp_date``, ``edd_date`` and
    ``risk_level``. A mother whose village is not in ``villages`` still counts in
    the facility totals (cannot happen with derived ``facility_id``).
    """
    rows: Dict[str, CensusVillageOut] = {
        v.id: CensusVillageOut(id=v.id, name=v.name, lat=v.lat, lng=v.lng) for v in villages
    }
    trimesters = TrimesterCountsOut()
    risks = RiskCountsOut()
    total = bpl = due = 0

    for m in mothers:
        if m.status != MotherStatus.active.value:
            continue
        is_due = m.edd_date.year == today.year and m.edd_date.month == today.month
        risk = _risk_key(m.risk_level)
        tri = trimester(ga_days(m.lmp_date, today))

        total += 1
        bpl += 1 if m.is_bpl else 0
        due += 1 if is_due else 0
        setattr(trimesters, f"t{tri}", getattr(trimesters, f"t{tri}") + 1)
        setattr(risks, risk, getattr(risks, risk) + 1)

        row = rows.get(m.village_id)
        if row is not None:
            row.pregnant += 1
            row.bpl += 1 if m.is_bpl else 0
            row.due_this_month += 1 if is_due else 0
            setattr(row, risk, getattr(row, risk) + 1)

    return CensusOut(
        facility=FacilityRefOut(id=facility.id, name=facility.name),
        as_of=today,
        total_pregnant=total,
        bpl_count=bpl,
        by_trimester=trimesters,
        due_this_month=due,
        risk_counts=risks,
        villages=list(rows.values()),
    )


# --------------------------------------------------------------------------- pure: queue


def sort_queue(
    rows: Iterable[QueueRowOut],
    village_id: Optional[str] = None,
    risk: Optional[str] = None,
) -> List[QueueRowOut]:
    """Filter by ``village_id`` / ``risk`` (when given), then sort RED → AMBER →
    GREEN, newest ``risk_updated_at`` first (null last), then name and id.
    Validating the filter values is the router's job."""
    kept = [
        r
        for r in rows
        if (village_id is None or r.village_id == village_id)
        and (risk is None or r.risk_level == risk)
    ]
    # Stable multi-pass sort, least significant key first.
    kept.sort(key=lambda r: (r.full_name, r.mother_id))
    kept.sort(key=lambda r: r.risk_updated_at or datetime.min, reverse=True)  # null last
    kept.sort(key=lambda r: RISK_RANK.get(r.risk_level, len(RISK_RANK)))
    return kept


def sorted_active_flags(flags: Iterable[Any]) -> List[Any]:
    """Active flags, worst severity first, then oldest first (so the top reason
    is the most severe, longest-standing problem), then code."""
    active = [f for f in flags if f.active]
    active.sort(
        key=lambda f: (_FLAG_SEVERITY_RANK.get(f.severity, 9), f.first_seen_at, f.code)
    )
    return active


# --------------------------------------------------------------------------- loaders


def _facility_or_404(session: Session, user: CurrentUser) -> Facility:
    facility = session.get(Facility, user.facility_id) if user.facility_id else None
    if facility is None:
        raise not_found()
    return facility


def facility_village_ids(session: Session, user: CurrentUser) -> List[str]:
    if user.facility_id is None:
        return []
    return list(
        session.execute(select(Village.id).where(Village.facility_id == user.facility_id))
        .scalars()
        .all()
    )


def _active_mothers_stmt(user: CurrentUser):
    return select(Mother).where(
        mother_scope_filter(user), Mother.status == MotherStatus.active.value
    )


def load_census(session: Session, user: CurrentUser, today: date) -> CensusOut:
    facility = _facility_or_404(session, user)
    villages = (
        session.execute(
            select(Village)
            .where(Village.facility_id == facility.id)
            .order_by(Village.name, Village.id)
        )
        .scalars()
        .all()
    )
    mothers = session.execute(_active_mothers_stmt(user)).scalars().all()
    return build_census(facility, villages, mothers, today)


def load_queue_rows(session: Session, user: CurrentUser, today: date) -> List[QueueRowOut]:
    """One unsorted ``QueueRowOut`` per active in-scope mother (4 queries total)."""
    mothers = (
        session.execute(
            _active_mothers_stmt(user).options(
                selectinload(Mother.village), selectinload(Mother.flags)
            )
        )
        .scalars()
        .all()
    )
    if not mothers:
        return []
    ids = [m.id for m in mothers]

    last_visit = dict(
        session.execute(
            select(Visit.mother_id, func.max(Visit.visit_date))
            .where(Visit.mother_id.in_(ids))
            .group_by(Visit.mother_id)
        ).all()
    )
    open_tasks = dict(
        session.execute(
            select(Task.mother_id, func.count(Task.id))
            .where(Task.mother_id.in_(ids), Task.status == TaskStatus.open.value)
            .group_by(Task.mother_id)
        ).all()
    )
    # Newest live RED alert per mother (same choice as alert_router.find_alert).
    live_red: Dict[str, Alert] = {}
    for alert in session.execute(
        select(Alert)
        .where(
            Alert.mother_id.in_(ids),
            Alert.severity == AlertSeverity.RED.value,
            Alert.status.in_(alert_router.LIVE_RED),
        )
        .order_by(Alert.created_at.desc(), Alert.id.desc())
    ).scalars():
        live_red.setdefault(alert.mother_id, alert)

    rows: List[QueueRowOut] = []
    for m in mothers:
        alert = live_red.get(m.id)
        rows.append(
            QueueRowOut(
                mother_id=m.id,
                full_name=m.full_name,
                guardian_name=m.guardian_name,
                village_id=m.village_id,
                village_name=m.village.name,
                is_bpl=m.is_bpl,
                ga_days=ga_days(m.lmp_date, today),
                edd_date=m.edd_date,
                risk_level=m.risk_level,
                flags=[FlagOut.model_validate(f) for f in sorted_active_flags(m.flags)],
                last_visit_date=last_visit.get(m.id),
                open_alert_id=alert.id if alert is not None else None,
                open_alert_status=alert.status if alert is not None else None,
                open_task_count=int(open_tasks.get(m.id, 0)),
                risk_updated_at=m.risk_updated_at,
            )
        )
    return rows


def load_mother_detail(
    session: Session, user: CurrentUser, mother_id: str, today: date
) -> MotherDetailOut:
    """Patient detail for an in-scope mother (404 otherwise, Req 6.3)."""
    mother = get_mother_in_scope(session, user, mother_id)
    active = sorted_active_flags(mother.flags)
    history = sorted(mother.flags, key=lambda f: (f.first_seen_at, f.code, f.id), reverse=True)
    tasks = (
        session.execute(
            select(Task)
            .where(Task.mother_id == mother.id)
            .options(selectinload(Task.issued_by))
            .order_by(Task.created_at.desc(), Task.id.desc())
        )
        .scalars()
        .all()
    )
    alerts = (
        session.execute(
            select(Alert)
            .where(Alert.mother_id == mother.id)
            .order_by(Alert.created_at.desc(), Alert.id.desc())
        )
        .scalars()
        .all()
    )
    outcome = mother.birth_outcome
    return MotherDetailOut(
        mother=MotherOut.from_model(mother, active),
        village=VillageOut.model_validate(mother.village),
        asha=UserRefOut(id=mother.asha.id, full_name=mother.asha.full_name),
        ga_days=ga_days(mother.lmp_date, today),
        visits=[VisitOut.model_validate(v) for v in mother.visits],
        flags_active=[FlagOut.model_validate(f) for f in active],
        flags_history=[FlagHistoryOut.model_validate(f) for f in history],
        tasks=[TaskOut.from_model(t, today) for t in tasks],
        alerts=[alert_router.alert_out(a, mother=mother, session=session) for a in alerts],
        birth_outcome=BirthOutcomeOut.model_validate(outcome) if outcome is not None else None,
    )


__all__ = [
    "RISK_RANK",
    "RISK_LEVELS",
    "build_census",
    "sort_queue",
    "sorted_active_flags",
    "facility_village_ids",
    "load_census",
    "load_queue_rows",
    "load_mother_detail",
]
