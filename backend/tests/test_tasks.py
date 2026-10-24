"""Doctor actions → ASHA tasks (Requirements 17.2, 23.2–23.8).

Goes through the real ``POST /api/mothers/{id}/tasks`` route. RED mothers are
produced with the ``add_visit``/``triage`` helpers from ``test_triage_service``.
"""
from __future__ import annotations

from datetime import timedelta
from typing import Any, Dict

import pytest
from sqlalchemy import select

from app import db
from app.models import Alert, Mother, NotificationOutbox, Task
from app.notifications import short_code
from app.timeutil import today_ist
from tests.test_alerts import alerts, set_alert_status
from tests.test_triage_service import add_visit, get_mother, triage


def url(mother_id: str) -> str:
    return f"/api/mothers/{mother_id}/tasks"


def body(**over: Any) -> Dict[str, Any]:
    data: Dict[str, Any] = {
        "action_type": "HOME_VISIT_48H",
        "instructions": "Check Hb and diet",
        "due_date": (today_ist() + timedelta(days=2)).isoformat(),
    }
    data.update(over)
    return {k: v for k, v in data.items() if v is not None}


def get_task(task_id: str) -> Task:
    with db.SessionLocal() as s:
        t = s.get(Task, task_id)
        s.expunge(t)
        return t


def task_sms():
    with db.SessionLocal() as s:
        rows = list(
            s.execute(
                select(NotificationOutbox).where(NotificationOutbox.kind == "task_assigned")
            ).scalars()
        )
        for r in rows:
            s.expunge(r)
        return rows


@pytest.fixture
def fw(world):
    return world.a


@pytest.fixture
def green_mother(fw) -> Mother:
    m = fw.mothers_in(fw.villages[0])[0]
    add_visit(m, days_ago=1)
    triage(m.id)
    return m


@pytest.fixture
def red_mother(green_mother) -> Mother:
    add_visit(green_mother, hb=6.5)
    triage(green_mother.id)
    return green_mother


# --------------------------------------------------------------------------- create


def test_create_auto_links_open_red_alert_and_actions_it(client, fw, red_mother, auth_headers):
    [alert] = alerts(red_mother.id)
    assert alert.status == "open"
    seq_before = get_mother(red_mother.id).change_seq

    resp = client.post(url(red_mother.id), json=body(), headers=auth_headers(fw.doctor))
    assert resp.status_code == 201, resp.text
    out = resp.json()
    assert out["status"] == "open" and out["is_overdue"] is False
    assert out["alert_id"] == alert.id  # Req 23.6
    assert out["asha_id"] == red_mother.asha_id == fw.asha.id
    assert out["issued_by_id"] == fw.doctor.id
    assert out["created_at"].endswith("Z")

    task = get_task(out["id"])
    assert task.change_seq > seq_before  # new Change_Seq (Req 23.2)
    [actioned] = alerts(red_mother.id)
    assert actioned.status == "actioned"  # Req 23.7

    [sms] = task_sms()  # Req 17.2
    assert sms.to_user_id == fw.asha.id
    assert sms.related_task_id == task.id and sms.related_alert_id == alert.id
    due = (today_ist() + timedelta(days=2)).strftime("%d-%m")
    assert sms.body == (
        f"MAATRIVA TASK: Home visit within 48 hours for {short_code(red_mother.id)}, due {due}."
    )
    assert red_mother.full_name not in sms.body


def test_acknowledged_alert_is_linked_too(client, fw, red_mother, auth_headers):
    [alert] = alerts(red_mother.id)
    set_alert_status(alert.id, "acknowledged")
    resp = client.post(url(red_mother.id), json=body(), headers=auth_headers(fw.doctor))
    assert resp.status_code == 201, resp.text
    assert resp.json()["alert_id"] == alert.id
    assert alerts(red_mother.id)[0].status == "actioned"


def test_create_without_red_alert_has_no_link(client, fw, green_mother, auth_headers):
    resp = client.post(
        url(green_mother.id), json=body(action_type="DIET_COUNSEL"), headers=auth_headers(fw.doctor)
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["alert_id"] is None
    assert alerts(green_mother.id) == []
    assert len(task_sms()) == 1


def test_closed_red_alert_is_not_auto_linked(client, fw, red_mother, auth_headers):
    [alert] = alerts(red_mother.id)
    set_alert_status(alert.id, "closed")
    resp = client.post(url(red_mother.id), json=body(), headers=auth_headers(fw.doctor))
    assert resp.status_code == 201
    assert resp.json()["alert_id"] is None
    assert alerts(red_mother.id)[0].status == "closed"


def test_explicit_alert_id_of_another_mother_is_422(client, fw, red_mother, auth_headers):
    other = fw.mothers_in(fw.villages[1])[0]
    add_visit(other, days_ago=1)
    add_visit(other, hb=6.1)
    triage(other.id)
    [other_alert] = alerts(other.id)

    resp = client.post(
        url(red_mother.id), json=body(alert_id=other_alert.id), headers=auth_headers(fw.doctor)
    )
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_ALERT"
    # Nothing written: the other mother's alert keeps its status, no task, no SMS.
    assert alerts(other.id)[0].status == "open"
    assert task_sms() == []


def test_explicit_own_alert_id_links(client, fw, red_mother, auth_headers):
    [alert] = alerts(red_mother.id)
    resp = client.post(
        url(red_mother.id), json=body(alert_id=alert.id.upper()), headers=auth_headers(fw.doctor)
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["alert_id"] == alert.id


# --------------------------------------------------------------------------- validation


@pytest.mark.parametrize(
    "over",
    [
        {"action_type": "TELEPORT"},
        {"instructions": "x" * 501},
        {"action_type": "OTHER", "instructions": None},
        {"action_type": "OTHER", "instructions": "   "},
        {"due_date": (today_ist() - timedelta(days=1)).isoformat()},
        {"due_date": (today_ist() + timedelta(days=61)).isoformat()},
        {"due_date": "not-a-date"},
    ],
    ids=["preset", "long-instructions", "other-missing", "other-blank", "past-due", "due-61", "bad-date"],
)
def test_validation_422(client, fw, green_mother, auth_headers, over):
    resp = client.post(url(green_mother.id), json=body(**over), headers=auth_headers(fw.doctor))
    assert resp.status_code == 422, resp.text
    with db.SessionLocal() as s:
        assert s.execute(select(Task)).first() is None
    assert task_sms() == []


@pytest.mark.parametrize("days", [0, 60])
def test_due_date_window_boundaries_accepted(client, fw, green_mother, auth_headers, days):
    due = (today_ist() + timedelta(days=days)).isoformat()
    resp = client.post(
        url(green_mother.id),
        json=body(action_type="OTHER", instructions="x" * 500, due_date=due),
        headers=auth_headers(fw.doctor),
    )
    assert resp.status_code == 201, resp.text


def test_delivered_mother_is_409(client, fw, green_mother, auth_headers):
    with db.SessionLocal() as s:
        db.begin_write(s)
        s.get(Mother, green_mother.id).status = "delivered"
        s.commit()
    resp = client.post(url(green_mother.id), json=body(), headers=auth_headers(fw.doctor))
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "MOTHER_INACTIVE"


# --------------------------------------------------------------------------- task list


def test_task_list_filters_and_overdue(client, fw, green_mother, red_mother, auth_headers):
    headers = auth_headers(fw.doctor)
    open_id = client.post(url(red_mother.id), json=body(), headers=headers).json()["id"]
    late_id = client.post(url(red_mother.id), json=body(), headers=headers).json()["id"]
    done_id = client.post(url(red_mother.id), json=body(), headers=headers).json()["id"]
    with db.SessionLocal() as s:
        seq = db.begin_write(s)
        s.get(Task, late_id).due_date = today_ist() - timedelta(days=1)
        done = s.get(Task, done_id)
        done.status, done.change_seq = "done", seq
        s.commit()

    def ids(status: str):
        resp = client.get(f"/api/tasks?status={status}", headers=headers)
        assert resp.status_code == 200, resp.text
        return {t["id"]: t for t in resp.json()}

    assert set(ids("all")) == {open_id, late_id, done_id}
    assert set(ids("open")) == {open_id, late_id}
    assert set(ids("done")) == {done_id}
    overdue = ids("overdue")
    assert set(overdue) == {late_id} and overdue[late_id]["is_overdue"] is True
    row = ids("all")[open_id]
    assert row["is_overdue"] is False and row["mother_name"] == red_mother.full_name
    assert client.get("/api/tasks?status=late", headers=headers).status_code == 422
    # ANM may read the list.
    assert client.get("/api/tasks", headers=auth_headers(fw.anm)).status_code == 200
