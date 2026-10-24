"""Triage persistence (Requirements 3.8, 15.1–15.8; design §10).

``apply_triage(session, mother_id, now)`` runs one writing transaction for one
mother:

1. ``db.begin_write`` FIRST (Req 15.1): takes the global write lock, so the flag
   diff below is race-free and at most one active RiskFlag per (mother, code)
   exists (Req 3.8).
2. "today" is the IST date of ``now`` (Req 15.2).
3. The pure ``triage.evaluate`` runs on plain facts; active flags are diffed:
   resolved (Req 15.3), inserted (Req 15.4) or updated in place (Req 15.5).
4. ``risk_level`` is the worst result severity (Req 15.6). ``risk_updated_at``
   and ``change_seq`` move only on a real change: the level, or the set of
   active ``(code, severity, reason)`` tuples (Req 15.7). A no-op rerun leaves
   the mother row untouched, so pulls do not resend it.
5. The alert router gets ``newly_active`` (codes active now but not before) and
   ``new_evidence`` (still-active codes whose ``source_visit_id`` moved to a
   NEWER visit in ``(visit_date, client_created_at)`` order, or whose previous
   source visit is gone).
6. ``risk.changed`` is appended on a level change (Req 15.8), the transaction is
   committed and the events are returned for the caller to publish after the
   commit (Req 18.6).

Delivered mothers: ``evaluate`` returns ``[]``, so every active flag resolves,
the level becomes GREEN and any open AMBER alert closes; a non-closed RED alert
is left to the birth-outcome path (Req 16.3, 16.10).

Log calls reference ids only, never names or phones (Req 46.4).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import alert_router, db, triage
from app.models import Mother, MotherStatus, RiskFlag, Visit, new_uuid
from app.timeutil import ist_date, to_utc_naive

log = logging.getLogger(__name__)

Event = Tuple[str, str, Dict[str, Any]]  # (facility_id, event name, payload)


@dataclass
class TriageOutcome:
    mother_id: str
    risk_level: str
    risk_changed: bool
    events: List[Event] = field(default_factory=list)


# --------------------------------------------------------------------------- facts


def mother_facts(mother: Mother) -> triage.MotherFacts:
    return triage.MotherFacts(
        lmp_date=mother.lmp_date,
        registered_on=ist_date(mother.registered_at),
        height_cm=mother.height_cm,
        first_weight_kg=mother.first_weight_kg,
        status=mother.status,
    )


def visit_facts(visit: Visit) -> triage.VisitFacts:
    return triage.VisitFacts(
        id=visit.id,
        visit_date=visit.visit_date,
        client_created_at=visit.client_created_at,
        weight_kg=visit.weight_kg,
        hb_gdl=visit.hb_gdl,
        bp_systolic=visit.bp_systolic,
        bp_diastolic=visit.bp_diastolic,
    )


def _visit_key(v: Visit) -> Tuple[date, datetime]:
    return (v.visit_date, v.client_created_at or datetime.min)


def _active_flags(session: Session, mother_id: str) -> List[RiskFlag]:
    return list(
        session.execute(
            select(RiskFlag)
            .where(RiskFlag.mother_id == mother_id, RiskFlag.active.is_(True))
            .order_by(RiskFlag.first_seen_at, RiskFlag.id)
            .execution_options(populate_existing=True)
        )
        .scalars()
        .all()
    )


def _set(obj: Any, name: str, value: Any) -> bool:
    """Assign only when the value differs, so no-op runs dirty nothing."""
    if getattr(obj, name) != value:
        setattr(obj, name, value)
        return True
    return False


def _is_newer_source(
    new_id: Optional[str], old_id: Optional[str], visits_by_id: Dict[str, Visit]
) -> bool:
    """True when ``new_id`` is a different visit that sorts after ``old_id``.
    A missing previous source (null after a demo delete, or no longer present)
    counts as older."""
    if new_id is None or new_id == old_id:
        return False
    new_visit = visits_by_id.get(new_id)
    if new_visit is None:
        return False
    old_visit = visits_by_id.get(old_id) if old_id is not None else None
    if old_visit is None:
        return True
    return _visit_key(new_visit) > _visit_key(old_visit)


def _diff_flags(
    session: Session,
    mother: Mother,
    active: Sequence[RiskFlag],
    results: Sequence[triage.RuleResult],
    now: datetime,
) -> None:
    by_code: Dict[str, RiskFlag] = {}
    for flag in active:
        if flag.code in by_code:
            # Defensive: a duplicate active row would break Req 3.8; keep the first.
            log.error("mother %s had duplicate active flag %s; resolving extra", mother.id, flag.code)
            flag.active = False
            flag.resolved_at = now
            continue
        by_code[flag.code] = flag

    result_codes = {r.code for r in results}
    for code, flag in by_code.items():
        if code not in result_codes:  # Req 15.3
            flag.active = False
            flag.resolved_at = now
            flag.last_evaluated_at = now

    for r in results:
        flag = by_code.get(r.code)
        if flag is None:  # Req 15.4
            session.add(
                RiskFlag(
                    id=new_uuid(),
                    mother_id=mother.id,
                    code=r.code,
                    severity=r.severity,
                    reason=r.reason,
                    source_visit_id=r.source_visit_id,
                    active=True,
                    first_seen_at=now,
                    last_evaluated_at=now,
                )
            )
        else:  # Req 15.5
            _set(flag, "severity", r.severity)
            _set(flag, "reason", r.reason)
            _set(flag, "source_visit_id", r.source_visit_id)
            _set(flag, "last_evaluated_at", now)


# --------------------------------------------------------------------------- apply


def apply_triage(session: Session, mother_id: str, now: datetime) -> TriageOutcome:
    """Re-evaluate one mother in its own writing transaction and commit.

    ``session`` must have no pending transaction work. ``now`` is naive UTC (an
    aware value is converted). Raises ``LookupError`` (after rolling back) when
    the mother does not exist; any other error propagates after a rollback.
    """
    now = to_utc_naive(now)
    try:
        seq = db.begin_write(session)  # FIRST statement (Req 15.1)
        today = ist_date(now)  # Req 15.2

        # populate_existing: the session may be reused (triage_all, routers) and
        # sessions do not expire on commit, so re-read under the write lock.
        mother = session.get(Mother, mother_id, populate_existing=True)
        if mother is None:
            raise LookupError(f"mother {mother_id} not found")

        visits = list(
            session.execute(
                select(Visit)
                .where(Visit.mother_id == mother.id)
                .execution_options(populate_existing=True)
            )
            .scalars()
            .all()
        )
        visits_by_id = {v.id: v for v in visits}
        results = triage.evaluate(mother_facts(mother), [visit_facts(v) for v in visits], today)

        # State before the diff.
        active = _active_flags(session, mother.id)
        before = {(f.code, f.severity, f.reason) for f in active}
        before_src: Dict[str, Optional[str]] = {f.code: f.source_visit_id for f in active}

        _diff_flags(session, mother, active, results, now)

        new_level = triage.worst(results)
        old_level = mother.risk_level
        after = {(r.code, r.severity, r.reason) for r in results}
        level_changed = new_level != old_level
        if level_changed or before != after:  # Req 15.6, 15.7
            mother.risk_level = new_level
            mother.risk_updated_at = now
            mother.change_seq = seq

        newly_active: Set[str] = {r.code for r in results} - set(before_src)
        new_evidence: Set[str] = {
            r.code
            for r in results
            if r.code in before_src
            and _is_newer_source(r.source_visit_id, before_src[r.code], visits_by_id)
        }

        events: List[Event] = alert_router.route(
            session, mother, results, newly_active, new_evidence, now
        )
        if level_changed:  # Req 15.8
            events.append(
                (
                    mother.facility_id,
                    "risk.changed",
                    {"mother_id": mother.id, "risk_level": new_level},
                )
            )
        session.commit()
    except Exception:
        session.rollback()
        raise

    if level_changed:
        log.info("mother %s risk %s -> %s", mother_id, old_level, new_level)
    return TriageOutcome(mother_id, new_level, level_changed, events)


def triage_all(now: datetime) -> List[TriageOutcome]:
    """Re-triage every active mother (startup and the periodic job, Req 15.9).

    Uses one ``db.SessionLocal()`` (read at call time) and one ``apply_triage``
    transaction per mother. A per-mother failure is logged at ERROR with the
    mother id, rolled back, and the loop continues (Req 15.10).
    """
    db._ensure_configured()  # noqa: SLF001 - same lazy config as get_db
    outcomes: List[TriageOutcome] = []
    with db.SessionLocal() as session:
        mother_ids = list(
            session.execute(
                select(Mother.id)
                .where(Mother.status == MotherStatus.active.value)
                .order_by(Mother.id)
            )
            .scalars()
            .all()
        )
        session.rollback()  # end the read transaction before the writes
        for mother_id in mother_ids:
            try:
                outcomes.append(apply_triage(session, mother_id, now))
            except Exception:
                log.exception("triage failed for mother %s", mother_id)
                session.rollback()
    return outcomes


__all__ = [
    "TriageOutcome",
    "mother_facts",
    "visit_facts",
    "apply_triage",
    "triage_all",
]
