"""Alert routing, lifecycle and the ack route (Requirements 10.5, 16.1, 16.2,
16.4–16.9, 44.4).

Triage runs through ``triage_service.apply_triage`` on visits written straight to
the DB, so the returned events can be inspected without the broker. Task
completion goes through the real ``POST /api/sync/push`` route; tasks are created
directly in the DB (``make_task``). See also ``test_sync_wiring.py`` for the
publish-after-commit checks.
"""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import List

import pytest
from sqlalchemy import select

from app import db, triage_service
from app.models import Alert, Mother, NotificationOutbox, Task
from app.notifications import short_code
from app.timeutil import utcnow
from tests.test_sync_push import _push, _results, make_task, task_change
from tests.test_triage_service import add_visit, event_names, triage

HB_SEVERE_65 = "Hb 6.5 g/dL (<7.0): severe anaemia"


# --------------------------------------------------------------------------- helpers


def alerts(mother_id: str, severity: str = None) -> List[Alert]:
    with db.SessionLocal() as s:
        stmt = select(Alert).where(Alert.mother_id == mother_id)
        if severity:
            stmt = stmt.where(Alert.severity == severity)
        rows = list(s.execute(stmt.order_by(Alert.created_at, Alert.id)).scalars())
        for r in rows:
            s.expunge(r)
        return rows


def sms(kind: str) -> List[NotificationOutbox]:
    with db.SessionLocal() as s:
        rows = list(
            s.execute(select(NotificationOutbox).where(NotificationOutbox.kind == kind)).scalars()
        )
        for r in rows:
            s.expunge(r)
        return rows


def set_alert_status(alert_id: str, status: str) -> None:
    with db.SessionLocal() as s:
        db.begin_write(s)
        s.get(Alert, alert_id).status = status
        s.commit()


@pytest.fixture
def fw(world):
    return world.a


@pytest.fixture
def mother(fw) -> Mother:
    m = fw.mothers_in(fw.villages[0])[0]
    add_visit(m, days_ago=1)  # GREEN baseline
    triage(m.id)
    return m


# --------------------------------------------------------------------------- RED


def test_red_creates_one_alert_and_one_sms_per_doctor(fw, factory, mother):
    doctor2 = factory.user("doctor", fw.facility, username="doctor2_a")
    add_visit(mother, hb=6.5)
    out = triage(mother.id)

    [alert] = alerts(mother.id)
    assert (alert.severity, alert.recipient_role, alert.status) == ("RED", "doctor", "open")
    assert alert.facility_id == fw.facility.id
    assert alert.codes == ["HB_SEVERE"]

    rows = sms("red_alert")
    assert sorted(r.to_user_id for r in rows) == sorted([fw.doctor.id, doctor2.id])
    village = fw.villages[0].name
    for r in rows:
        assert r.body == f"MAATRIVA RED: {short_code(mother.id)} {village} - {HB_SEVERE_65}. Open dashboard."
        assert mother.full_name not in r.body
        assert r.related_alert_id == alert.id and r.status == "mock_sent"

    assert event_names(out) == ["alert.created", "risk.changed"]
    payload = out.events[0][2]
    assert payload["alert"]["id"] == alert.id
    assert payload["alert"]["reasons"] == [HB_SEVERE_65]


def test_repeat_red_updates_existing_alert(mother):
    add_visit(mother, hb=6.5)
    triage(mother.id)
    [alert] = alerts(mother.id)

    # Same RED code re-confirmed while the alert is live: no new alert, no event.
    add_visit(mother, hb=6.2)
    again = triage(mother.id)
    assert [a.id for a in alerts(mother.id)] == [alert.id]
    assert not any(n.startswith("alert.") for n in event_names(again))
    assert len(sms("red_alert")) == 1

    # A NEW RED code updates the same alert (Req 16.2).
    add_visit(mother, hb=6.2, bp=(165, 112))
    upd = triage(mother.id)
    [same] = alerts(mother.id)
    assert same.id == alert.id
    assert same.codes == ["HB_SEVERE", "BP_SEVERE"]
    assert same.updated_at >= alert.updated_at
    assert event_names(upd) == ["alert.updated"]
    assert upd.events[0][2]["new_codes"] == ["BP_SEVERE"]


def test_actioned_alert_reopened_by_new_red_code(mother):
    add_visit(mother, hb=6.5)
    triage(mother.id)
    [alert] = alerts(mother.id)
    set_alert_status(alert.id, "actioned")

    add_visit(mother, hb=6.5, bp=(170, 100))
    out = triage(mother.id)
    [reopened] = alerts(mother.id)
    assert reopened.id == alert.id and reopened.status == "open"
    assert event_names(out) == ["alert.updated"]
    assert out.events[0][2]["alert"]["status"] == "open"


# --------------------------------------------------------------------------- AMBER


def test_amber_routed_to_anm_without_doctor_sms(mother):
    add_visit(mother, hb=9.0)
    out = triage(mother.id)

    [alert] = alerts(mother.id)
    assert (alert.severity, alert.recipient_role, alert.status) == ("AMBER", "anm", "open")
    assert alert.codes == ["HB_MODERATE"]
    assert sms("red_alert") == []
    assert event_names(out) == ["risk.changed"]  # AMBER alerts are never published


def test_amber_closes_when_amber_codes_clear(mother):
    add_visit(mother, hb=9.0)
    triage(mother.id)
    add_visit(mother, hb=11.6)
    triage(mother.id)

    [alert] = alerts(mother.id)
    assert alert.status == "closed" and alert.closed_at is not None


def test_amber_closes_when_mother_becomes_red(mother):
    add_visit(mother, hb=9.0)
    triage(mother.id)
    add_visit(mother, hb=6.5)
    triage(mother.id)

    [amber] = alerts(mother.id, "AMBER")
    [red] = alerts(mother.id, "RED")
    assert amber.status == "closed"
    assert red.status == "open"


# --------------------------------------------------------------------------- task done


def _red_alert_with_linked_task(fw, mother):
    add_visit(mother, hb=6.5)
    triage(mother.id)
    [alert] = alerts(mother.id)
    task_id = make_task(mother, fw.doctor, fw.asha)
    with db.SessionLocal() as s:
        db.begin_write(s)
        s.get(Task, task_id).alert_id = alert.id
        s.get(Alert, alert.id).status = "actioned"
        s.commit()
    return alert, task_id


def test_task_done_closes_alert_and_writes_task_done_sms(client, fw, mother, auth_headers):
    alert, task_id = _red_alert_with_linked_task(fw, mother)

    [r] = _results(_push(client, auth_headers(fw.asha), task_change(task_id)))
    assert r["status"] == "applied"

    [closed] = alerts(mother.id)
    assert closed.status == "closed" and closed.closed_at is not None
    [done_sms] = sms("task_done")
    assert done_sms.to_user_id == fw.doctor.id
    assert done_sms.related_alert_id == alert.id and done_sms.related_task_id == task_id


def test_new_severe_visit_after_closed_alert_creates_new_alert(client, fw, mother, auth_headers):
    alert, task_id = _red_alert_with_linked_task(fw, mother)
    _results(_push(client, auth_headers(fw.asha), task_change(task_id)))
    assert alerts(mother.id)[0].status == "closed"

    # Hb still < 7 on a NEW visit: re-confirmed by newer evidence (Req 16.1).
    add_visit(mother, hb=6.6)
    out = triage(mother.id)

    old, new = alerts(mother.id)
    assert old.id == alert.id and old.status == "closed"
    assert new.status == "open" and new.codes == ["HB_SEVERE"]
    assert "alert.created" in event_names(out)
    assert len(sms("red_alert")) == 2


def test_periodic_retriage_without_new_visit_creates_no_alert(fw, mother):
    add_visit(mother, hb=6.5)
    triage(mother.id)
    [alert] = alerts(mother.id)
    set_alert_status(alert.id, "closed")

    # Same day, and 40 days later (VISIT_OVERDUE becomes newly active, AMBER).
    triage_service.triage_all(utcnow())
    outcomes = triage_service.triage_all(utcnow() + timedelta(days=40))

    assert [a.id for a in alerts(mother.id)] == [alert.id]
    assert len(sms("red_alert")) == 1
    mine = [o for o in outcomes if o.mother_id == mother.id]
    assert mine and not any(n.startswith("alert.") for o in mine for n in event_names(o))


def test_no_doctor_still_creates_alert_and_warns(factory, caplog):
    fac = factory.facility(name="PHC No Doctor")
    village = factory.village(fac)
    asha = factory.user("asha", fac, villages=[village])
    m = factory.mother(village, asha)
    add_visit(m, hb=6.5)

    caplog.set_level(logging.WARNING, logger="app.alert_router")
    out = triage(m.id)

    [alert] = alerts(m.id)
    assert alert.status == "open" and alert.severity == "RED"
    assert sms("red_alert") == []
    assert "alert.created" in event_names(out)
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert any(alert.id in r.getMessage() and "no doctor" in r.getMessage() for r in warnings)
    assert all(m.full_name not in r.getMessage() for r in caplog.records)


# --------------------------------------------------------------------------- ack route


def test_ack_then_ack_again_is_409(client, world, mother, auth_headers):
    fw = world.a
    add_visit(mother, hb=6.5)
    triage(mother.id)
    [alert] = alerts(mother.id)
    url = f"/api/alerts/{alert.id}/ack"

    resp = client.post(url, headers=auth_headers(fw.doctor))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["id"] == alert.id and body["status"] == "acknowledged"
    assert body["acknowledged_at"].endswith("Z")
    stored = alerts(mother.id)[0]
    assert stored.status == "acknowledged" and stored.acknowledged_at is not None

    again = client.post(url, headers=auth_headers(fw.doctor))
    assert again.status_code == 409
    assert again.json()["detail"]["code"] == "INVALID_STATE"

    # Out of scope: another facility's doctor gets 404; the ANM gets 403.
    assert client.post(url, headers=auth_headers(world.b.doctor)).status_code == 404
    assert client.post(url, headers=auth_headers(fw.anm)).status_code == 403
