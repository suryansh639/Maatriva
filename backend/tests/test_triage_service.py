"""Triage persistence (Requirements 15.2–15.8, 44.4).

Calls ``triage_service.apply_triage`` directly on rows written by the factories.
Each mother gets a recent normal visit first so she starts GREEN (a factory
mother with no visit is ``VISIT_OVERDUE``: registered 60 days ago).
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import List, Optional

import pytest
from sqlalchemy import select

from app import db, triage_service
from app.models import Mother, RiskFlag, Visit, new_uuid
from app.timeutil import today_ist, utcnow


# --------------------------------------------------------------------------- helpers


def add_visit(
    mother: Mother,
    *,
    days_ago: int = 0,
    hb: Optional[float] = 11.5,
    weight: Optional[float] = 55.0,
    bp: Optional[tuple] = (112, 72),
    created_at: Optional[datetime] = None,
) -> str:
    """Insert a visit directly (no triage). Later calls sort later on equal dates."""
    with db.SessionLocal() as s:
        seq = db.begin_write(s)
        visit = Visit(
            id=new_uuid(),
            mother_id=mother.id,
            visit_date=today_ist() - timedelta(days=days_ago),
            weight_kg=weight,
            weight_source="manual" if weight is not None else None,
            hb_gdl=hb,
            hb_source="manual" if hb is not None else None,
            bp_systolic=bp[0] if bp else None,
            bp_diastolic=bp[1] if bp else None,
            bp_source="manual" if bp else None,
            recorded_by_id=mother.asha_id,
            client_created_at=created_at or utcnow(),
            change_seq=seq,
        )
        s.add(visit)
        s.commit()
        return visit.id


def triage(mother_id: str, now: Optional[datetime] = None) -> triage_service.TriageOutcome:
    with db.SessionLocal() as s:
        return triage_service.apply_triage(s, mother_id, now or utcnow())


def flags(mother_id: str, active: Optional[bool] = None) -> List[RiskFlag]:
    with db.SessionLocal() as s:
        stmt = select(RiskFlag).where(RiskFlag.mother_id == mother_id)
        if active is not None:
            stmt = stmt.where(RiskFlag.active.is_(active))
        rows = list(s.execute(stmt.order_by(RiskFlag.first_seen_at, RiskFlag.id)).scalars())
        for r in rows:
            s.expunge(r)
        return rows


def get_mother(mother_id: str) -> Mother:
    with db.SessionLocal() as s:
        m = s.get(Mother, mother_id)
        s.expunge(m)
        return m


def event_names(outcome: triage_service.TriageOutcome) -> List[str]:
    return [name for _fac, name, _payload in outcome.events]


@pytest.fixture
def mother(world) -> Mother:
    m = world.a.mothers_in(world.a.villages[0])[0]
    add_visit(m, days_ago=1)  # normal readings: GREEN baseline
    return m


# --------------------------------------------------------------------------- tests


def test_new_code_inserts_active_flag_and_raises_risk(mother):
    before = get_mother(mother.id)
    add_visit(mother, hb=6.5)
    out = triage(mother.id)

    [flag] = flags(mother.id, active=True)
    assert (flag.code, flag.severity) == ("HB_SEVERE", "RED")
    assert flag.reason == "Hb 6.5 g/dL (<7.0): severe anaemia"
    assert flag.source_visit_id is not None and flag.resolved_at is None

    after = get_mother(mother.id)
    assert after.risk_level == "RED" and out.risk_level == "RED" and out.risk_changed
    assert after.risk_updated_at is not None
    assert after.change_seq > before.change_seq
    assert event_names(out)[-1] == "risk.changed"
    fac, _name, payload = out.events[-1]
    assert fac == mother.facility_id
    assert payload == {"mother_id": mother.id, "risk_level": "RED"}


def test_existing_code_updates_flag_in_place(mother):
    first_visit = add_visit(mother, hb=6.5)
    triage(mother.id)
    [old] = flags(mother.id, active=True)
    seq_before = get_mother(mother.id).change_seq

    second_visit = add_visit(mother, hb=6.0)
    out = triage(mother.id)

    [new] = flags(mother.id, active=True)
    assert new.id == old.id  # same row, no second active flag (Req 3.8)
    assert old.source_visit_id == first_visit
    assert new.source_visit_id == second_visit
    assert new.reason == "Hb 6.0 g/dL (<7.0): severe anaemia"
    assert new.last_evaluated_at >= old.last_evaluated_at
    assert len(flags(mother.id)) == 1
    # Reason changed -> new change_seq, but the level did not: no risk.changed.
    assert get_mother(mother.id).change_seq > seq_before
    assert not out.risk_changed and "risk.changed" not in event_names(out)


def test_cleared_code_resolves_flag_and_lowers_risk(mother):
    add_visit(mother, hb=6.5)
    triage(mother.id)
    add_visit(mother, hb=11.8)
    out = triage(mother.id)

    assert flags(mother.id, active=True) == []
    [resolved] = flags(mother.id, active=False)
    assert resolved.code == "HB_SEVERE" and resolved.resolved_at is not None
    assert get_mother(mother.id).risk_level == "GREEN"
    assert out.risk_changed
    assert out.events[-1][2] == {"mother_id": mother.id, "risk_level": "GREEN"}


def test_noop_rerun_changes_nothing(mother):
    add_visit(mother, hb=9.0)
    now = utcnow()
    triage(mother.id, now)
    m1 = get_mother(mother.id)
    [f1] = flags(mother.id, active=True)

    out = triage(mother.id, now + timedelta(minutes=5))
    m2 = get_mother(mother.id)
    [f2] = flags(mother.id, active=True)

    assert m2.risk_level == m1.risk_level == "AMBER"
    assert m2.change_seq == m1.change_seq  # pulls do not resend her
    assert m2.risk_updated_at == m1.risk_updated_at
    assert (f2.id, f2.reason, f2.severity) == (f1.id, f1.reason, f1.severity)
    assert not out.risk_changed and out.events == []


def test_today_is_ist_date_of_now(mother):
    """A time-based rule fires from ``now`` alone, with no new visit (Req 15.2)."""
    out = triage(mother.id)
    assert out.risk_level == "GREEN"

    later = triage(mother.id, utcnow() + timedelta(days=40))
    assert later.risk_level == "AMBER" and later.risk_changed
    assert [f.code for f in flags(mother.id, active=True)] == ["VISIT_OVERDUE"]


def test_missing_mother_raises_lookup_error(db_engine):
    with pytest.raises(LookupError):
        triage(new_uuid())
