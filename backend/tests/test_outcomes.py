"""Birth outcomes and outcome metrics (Requirements 3.11, 16.10, 24.1–24.4,
24.6, 24.7).

Recording goes through ``POST /api/mothers/{id}/birth-outcome``; the published
events are checked by calling ``outcome_service.record`` directly. Mothers are
created at GA 250 so that a delivery today is past LMP + 140 days.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Dict, List

import pytest
from sqlalchemy import select

from app import db, outcome_service
from app.deps import load_current_user
from app.models import BirthOutcome, Mother, Task
from app.schemas import BirthOutcomeIn
from app.timeutil import today_ist, utcnow
from tests.test_alerts import alerts
from tests.test_tasks import body as task_body
from tests.test_triage_service import add_visit, flags, get_mother, triage


def url(mother_id: str) -> str:
    return f"/api/mothers/{mother_id}/birth-outcome"


def outcome_body(**over: Any) -> Dict[str, Any]:
    data: Dict[str, Any] = {
        "delivery_date": today_ist().isoformat(),
        "outcome": "live_birth",
        "birth_weight_kg": 3.0,
    }
    data.update(over)
    return {k: v for k, v in data.items() if v is not None}


def tasks_of(mother_id: str) -> List[Task]:
    with db.SessionLocal() as s:
        rows = list(
            s.execute(
                select(Task).where(Task.mother_id == mother_id).order_by(Task.created_at, Task.id)
            ).scalars()
        )
        for r in rows:
            s.expunge(r)
        return rows


def outcome_count() -> int:
    with db.SessionLocal() as s:
        return len(s.execute(select(BirthOutcome.id)).all())


@pytest.fixture
def fw(world):
    return world.a


@pytest.fixture
def late_mother(factory, fw) -> Mother:
    """GA 250, GREEN after a normal visit yesterday."""
    m = factory.mother(fw.villages[0], fw.asha, ga=250)
    add_visit(m, days_ago=1)
    triage(m.id)
    return m


@pytest.fixture
def red_late_mother(late_mother) -> Mother:
    add_visit(late_mother, hb=6.5)
    triage(late_mother.id)
    return late_mother


# --------------------------------------------------------------------------- delivered rules


def test_outcome_applies_delivered_rules(client, fw, red_late_mother, auth_headers):
    m = red_late_mother
    headers = auth_headers(fw.doctor)
    for _ in range(2):
        assert client.post(f"/api/mothers/{m.id}/tasks", json=task_body(), headers=headers).status_code == 201
    [alert] = alerts(m.id)
    assert alert.status == "actioned"
    seq_before = get_mother(m.id).change_seq

    resp = client.post(url(m.id), json=outcome_body(birth_weight_kg=2.4), headers=headers)
    assert resp.status_code == 201, resp.text
    out = resp.json()
    assert out["mother_id"] == m.id and out["outcome"] == "live_birth"
    assert out["is_lbw"] is True and out["birth_weight_kg"] == 2.4
    assert out["recorded_by_id"] == fw.doctor.id and out["created_at"].endswith("Z")

    after = get_mother(m.id)
    assert after.status == "delivered" and after.risk_level == "GREEN"
    assert after.change_seq > seq_before and after.risk_updated_at is not None
    assert flags(m.id, active=True) == []
    assert all(f.resolved_at is not None for f in flags(m.id, active=False))
    [closed] = alerts(m.id)
    assert closed.status == "closed" and closed.closed_at is not None
    cancelled = tasks_of(m.id)
    assert len(cancelled) == 2
    assert all(t.status == "cancelled" and t.change_seq == after.change_seq for t in cancelled)

    # Delivered mothers take no new tasks and leave the queue.
    again = client.post(f"/api/mothers/{m.id}/tasks", json=task_body(), headers=headers)
    assert again.status_code == 409 and again.json()["detail"]["code"] == "MOTHER_INACTIVE"
    queue = client.get("/api/dashboard/queue", headers=headers).json()
    assert m.id not in {r["mother_id"] for r in queue}


def test_open_amber_alert_is_closed_too(client, fw, late_mother, auth_headers):
    add_visit(late_mother, hb=9.0)
    triage(late_mother.id)
    [amber] = alerts(late_mother.id)
    assert amber.severity == "AMBER" and amber.status == "open"

    resp = client.post(url(late_mother.id), json=outcome_body(), headers=auth_headers(fw.doctor))
    assert resp.status_code == 201, resp.text
    assert resp.json()["is_lbw"] is False
    assert alerts(late_mother.id)[0].status == "closed"


def test_stillbirth_without_weight_is_not_lbw(client, fw, late_mother, auth_headers):
    resp = client.post(
        url(late_mother.id),
        json=outcome_body(outcome="stillbirth", birth_weight_kg=None),
        headers=auth_headers(fw.doctor),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["birth_weight_kg"] is None and resp.json()["is_lbw"] is False


def test_record_returns_events_for_closed_red_alert_and_risk(fw, red_late_mother):
    [alert] = alerts(red_late_mother.id)
    with db.SessionLocal() as s:
        user = load_current_user(s, fw.doctor.id)
    with db.SessionLocal() as s:
        out = outcome_service.record(
            s, user, red_late_mother.id, BirthOutcomeIn(**outcome_body()), utcnow()
        )
    names = [name for _fac, name, _p in out.events]
    assert names == ["alert.updated", "risk.changed"]
    updated = out.events[0][2]
    assert updated["alert"]["id"] == alert.id and updated["alert"]["status"] == "closed"
    assert updated["new_codes"] == []
    assert out.events[1] == (
        fw.facility.id,
        "risk.changed",
        {"mother_id": red_late_mother.id, "risk_level": "GREEN"},
    )


def test_already_recorded_is_409(client, fw, late_mother, auth_headers):
    headers = auth_headers(fw.doctor)
    assert client.post(url(late_mother.id), json=outcome_body(), headers=headers).status_code == 201
    resp = client.post(url(late_mother.id), json=outcome_body(), headers=headers)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "ALREADY_RECORDED"
    assert outcome_count() == 1


# --------------------------------------------------------------------------- validation


@pytest.mark.parametrize(
    "over",
    [
        {"birth_weight_kg": None},
        {"birth_weight_kg": 0.29},
        {"birth_weight_kg": 6.01},
        {"outcome": "miscarriage"},
        {"delivery_date": (today_ist() + timedelta(days=1)).isoformat()},
    ],
    ids=["live-no-weight", "weight-low", "weight-high", "bad-outcome", "future"],
)
def test_validation_422(client, fw, late_mother, auth_headers, over):
    resp = client.post(url(late_mother.id), json=outcome_body(**over), headers=auth_headers(fw.doctor))
    assert resp.status_code == 422, resp.text
    assert outcome_count() == 0
    assert get_mother(late_mother.id).status == "active"


def test_delivery_before_lmp_plus_140_is_422(client, fw, late_mother, auth_headers):
    headers = auth_headers(fw.doctor)
    lmp = late_mother.lmp_date
    early = client.post(
        url(late_mother.id),
        json=outcome_body(delivery_date=(lmp + timedelta(days=139)).isoformat()),
        headers=headers,
    )
    assert early.status_code == 422
    assert early.json()["detail"]["code"] == "VALIDATION_ERROR"
    ok = client.post(
        url(late_mother.id),
        json=outcome_body(delivery_date=(lmp + timedelta(days=140)).isoformat()),
        headers=headers,
    )
    assert ok.status_code == 201, ok.text


# --------------------------------------------------------------------------- metrics


@pytest.mark.parametrize(
    "readings, expected",
    [
        ([(date(2025, 1, 1), 7.3), (date(2025, 1, 20), 7.8)], True),  # exactly 0.5
        ([(date(2025, 1, 1), 7.3), (date(2025, 1, 20), 7.7)], False),
        ([(date(2025, 1, 10), 7.0), (date(2025, 1, 20), 9.0)], True),  # on the task day counts as before
        ([(date(2025, 1, 20), 9.0)], None),  # nothing before
        ([(date(2025, 1, 1), 7.0)], None),  # nothing after
        ([(date(2025, 1, 1), 6.0), (date(2025, 1, 5), 8.0), (date(2025, 1, 20), 8.2)], False),
    ],
)
def test_hb_improved_rule(readings, expected):
    assert outcome_service.HB_IMPROVED_MIN_DELTA == 0.5
    assert outcome_service.hb_improved(readings, date(2025, 1, 10)) is expected


def _task_created_days_ago(client, headers, mother_id: str, days: int) -> None:
    resp = client.post(f"/api/mothers/{mother_id}/tasks", json=task_body(), headers=headers)
    assert resp.status_code == 201, resp.text
    with db.SessionLocal() as s:
        db.begin_write(s)
        s.get(Task, resp.json()["id"]).created_at = utcnow() - timedelta(days=days)
        s.commit()


def test_outcome_metrics(client, world, factory, auth_headers):
    fw = world.a
    headers = auth_headers(fw.doctor)
    improved, flat = fw.mothers  # one per village
    no_followup = factory.mother(fw.villages[0], fw.asha)

    add_visit(improved, days_ago=25, hb=6.5)
    add_visit(improved, days_ago=5, hb=7.3)
    add_visit(flat, days_ago=25, hb=9.0)
    add_visit(flat, days_ago=5, hb=9.3)
    add_visit(no_followup, days_ago=25, hb=8.0)
    for m in (improved, flat, no_followup):
        _task_created_days_ago(client, headers, m.id, 20)

    for weight, kind in ((2.3, "live_birth"), (3.1, "live_birth"), (None, "stillbirth")):
        m = factory.mother(fw.villages[1], fw.asha2, ga=260)
        resp = client.post(
            url(m.id), json=outcome_body(outcome=kind, birth_weight_kg=weight), headers=headers
        )
        assert resp.status_code == 201, resp.text

    resp = client.get("/api/outcomes", headers=auth_headers(fw.anm))
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "hb_improved_after_action": 1,
        "mothers_with_action_and_followup_hb": 2,
        "births_recorded": 3,
        "lbw_count": 1,
        "live_births": 2,
    }
    # Facility B sees none of facility A's outcomes.
    other = client.get("/api/outcomes", headers=auth_headers(world.b.doctor)).json()
    assert set(other.values()) == {0}
