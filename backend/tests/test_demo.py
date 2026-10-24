"""Demo endpoints (Requirements 40.1–40.5, 16.1, 39.10).

The endpoints use the real clock, so the module seeds one template database for
today's IST date; ``db_engine`` is overridden so every test (and the conftest
``app``/``client`` fixtures) runs on a private copy of it.
"""
from __future__ import annotations

from datetime import timedelta
from typing import Dict, List

import pytest
from sqlalchemy import select

from app import alert_router, db, demo_data
from app.config import get_settings
from app.models import (
    Alert,
    AlertSeverity,
    AlertStatus,
    Mother,
    NotificationOutbox,
    RiskFlag,
    SyncCounter,
    Task,
    TaskStatus,
    Visit,
)
from app.timeutil import iso_z, today_ist, utcnow
from tests import seeding
from tests.factories import auth_headers

TRIGGER = "/api/demo/trigger-red"
RESET = "/api/demo/reset"
MID = demo_data.DEMO_MOTHER_ID
DEVICE_ID = "11111111-2222-4333-8444-555555555555"

HB_REASON = "Hb 6.8 g/dL (<7.0): severe anaemia"
LOSS_REASON = "Weight down 1.4 kg in 4 weeks after 20 weeks"


@pytest.fixture(scope="module")
def demo_template(tmp_path_factory):
    path, _report = seeding.build_template(tmp_path_factory.mktemp("demo-template"), today_ist())
    return path


@pytest.fixture
def db_engine(demo_template, tmp_path):
    """Overrides the conftest fixture: a private copy of the seeded database."""
    engine = seeding.open_copy(demo_template, tmp_path)
    try:
        yield engine
    finally:
        seeding.close_copy()


@pytest.fixture
def demo_on(monkeypatch):
    monkeypatch.setenv("MAATRIVA_DEMO", "1")
    get_settings.cache_clear()


@pytest.fixture
def users(db_engine):
    return seeding.users_by_name()


@pytest.fixture
def doctor(users) -> Dict[str, str]:
    return auth_headers(users["doctor1"])


# --------------------------------------------------------------------------- helpers


def _trigger(client, headers) -> Dict:
    resp = client.post(TRIGGER, headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _reset(client, headers) -> Dict:
    resp = client.post(RESET, headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _alerts(severity: str = AlertSeverity.RED.value) -> List[Alert]:
    with db.SessionLocal() as s:
        return list(
            s.execute(
                select(Alert)
                .where(Alert.mother_id == MID, Alert.severity == severity)
                .order_by(Alert.created_at)
            ).scalars()
        )


def _active_flags() -> Dict[str, RiskFlag]:
    with db.SessionLocal() as s:
        rows = s.execute(
            select(RiskFlag).where(RiskFlag.mother_id == MID, RiskFlag.active.is_(True))
        ).scalars()
        return {f.code: f for f in rows}


def _visits() -> List[Visit]:
    with db.SessionLocal() as s:
        return list(
            s.execute(select(Visit).where(Visit.mother_id == MID).order_by(Visit.visit_date)).scalars()
        )


def _epoch() -> str:
    with db.SessionLocal() as s:
        return s.get(SyncCounter, 1).epoch


def _live_red() -> List[Alert]:
    return [a for a in _alerts() if a.status in alert_router.LIVE_RED]


def _issue_task(client, headers, alert_id=None) -> Dict:
    body = {"action_type": "HOME_VISIT_48H", "due_date": (today_ist() + timedelta(days=2)).isoformat()}
    if alert_id:
        body["alert_id"] = alert_id
    resp = client.post(f"/api/mothers/{MID}/tasks", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _complete_task(client, asha_headers, task_id: str) -> None:
    change = {
        "entity": "task",
        "op": "complete",
        "data": {"id": task_id, "done_at": iso_z(utcnow() - timedelta(seconds=5)), "done_note": "visited"},
    }
    resp = client.post(
        "/api/sync/push", json={"device_id": DEVICE_ID, "changes": [change]}, headers=asha_headers
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["results"][0]["status"] == "applied"


# --------------------------------------------------------------------------- gating


@pytest.mark.parametrize("value", [None, "0", "true"])
@pytest.mark.parametrize("path", [TRIGGER, RESET])
def test_404_when_demo_mode_is_off(client, doctor, monkeypatch, value, path):
    if value is None:
        monkeypatch.delenv("MAATRIVA_DEMO", raising=False)
    else:
        monkeypatch.setenv("MAATRIVA_DEMO", value)
    get_settings.cache_clear()

    for headers in (doctor, {}):  # the demo check runs before authentication
        resp = client.post(path, headers=headers)
        assert resp.status_code == 404, resp.text
        assert resp.json()["detail"]["code"] == "NOT_FOUND"
    assert _visits()[-1].device_id == demo_data.DEMO_SEED_DEVICE_ID  # nothing written


def test_roles(client, users, demo_on):
    assert client.post(TRIGGER).status_code == 401
    for name in ("anm1", "asha1"):
        resp = client.post(TRIGGER, headers=auth_headers(users[name]))
        assert resp.status_code == 403 and resp.json()["detail"]["code"] == "FORBIDDEN"
    admin = auth_headers(users["admin1"])
    assert _trigger(client, admin)["risk_level"] == "RED"
    assert _reset(client, admin)["risk_level"] == "GREEN"


# --------------------------------------------------------------------------- trigger-red


def test_trigger_red_raises_red_with_hb_severe_and_weight_loss(client, doctor, demo_on):
    body = _trigger(client, doctor)

    assert body["mother_id"] == MID and body["risk_level"] == "RED"
    assert body["alert_id"] is not None

    flags = _active_flags()
    assert {"HB_SEVERE", "WEIGHT_LOSS"} <= set(flags)
    assert flags["HB_SEVERE"].reason == HB_REASON and flags["HB_SEVERE"].severity == "RED"
    assert flags["WEIGHT_LOSS"].reason == LOSS_REASON and flags["WEIGHT_LOSS"].severity == "RED"

    trigger = [v for v in _visits() if v.device_id == demo_data.DEMO_TRIGGER_DEVICE_ID]
    assert len(trigger) == 1
    v = trigger[0]
    assert (v.visit_date, v.weight_kg, v.weight_source, v.hb_gdl) == (today_ist(), 56.6, "simulated", 6.8)
    assert flags["HB_SEVERE"].source_visit_id == v.id == flags["WEIGHT_LOSS"].source_visit_id

    (alert,) = _alerts()
    assert alert.id == body["alert_id"] and alert.status == AlertStatus.open.value
    assert alert.recipient_role == "doctor"
    assert {"HB_SEVERE", "WEIGHT_LOSS"} <= set(alert.codes)

    with db.SessionLocal() as s:
        mother = s.get(Mother, MID)
        sms = s.execute(
            select(NotificationOutbox).where(NotificationOutbox.related_alert_id == alert.id)
        ).scalars().all()
    assert mother.risk_level == "RED"
    assert [n.kind for n in sms] == ["red_alert"]  # one doctor in the seed
    assert demo_data.DEMO_MOTHER_NAME not in sms[0].body


def test_trigger_red_twice_creates_one_fresh_alert(client, doctor, demo_on):
    first = _trigger(client, doctor)
    epoch = _epoch()
    second = _trigger(client, doctor)  # no FK error deleting the flagged trigger visit

    assert second["risk_level"] == "RED"
    assert second["alert_id"] is not None and second["alert_id"] != first["alert_id"]
    assert _epoch() != epoch  # previous trigger visit deleted

    alerts = {a.id: a for a in _alerts()}
    assert set(alerts) == {first["alert_id"], second["alert_id"]}
    old = alerts[first["alert_id"]]
    assert old.status == AlertStatus.closed.value and old.closed_at is not None
    assert [a.id for a in _live_red()] == [second["alert_id"]]

    trigger = [v for v in _visits() if v.device_id == demo_data.DEMO_TRIGGER_DEVICE_ID]
    assert len(trigger) == 1
    assert trigger[0].weight_kg == 56.6  # base excludes earlier trigger visits
    flags = _active_flags()
    assert flags["HB_SEVERE"].source_visit_id == trigger[0].id

    with db.SessionLocal() as s:
        sms = s.execute(
            select(NotificationOutbox.related_alert_id).where(NotificationOutbox.kind == "red_alert")
        ).scalars().all()
    assert sms.count(second["alert_id"]) == 1


def test_trigger_red_after_loop_closed_alerts_again(client, users, doctor, demo_on):
    first = _trigger(client, doctor)
    task = _issue_task(client, doctor)  # linked to the open RED alert
    assert task["alert_id"] == first["alert_id"]
    _complete_task(client, auth_headers(users["asha1"]), task["id"])

    (closed,) = _alerts()
    assert closed.status == AlertStatus.closed.value
    assert _live_red() == []

    again = _trigger(client, doctor)
    assert again["risk_level"] == "RED"
    assert again["alert_id"] not in (None, first["alert_id"])
    assert [a.id for a in _live_red()] == [again["alert_id"]]


# --------------------------------------------------------------------------- reset


def test_reset_after_red_run_returns_green_with_rotated_epoch(client, doctor, demo_on):
    red = _trigger(client, doctor)
    task = _issue_task(client, doctor, alert_id=red["alert_id"])
    epoch = _epoch()

    body = _reset(client, doctor)
    assert body == {"mother_id": MID, "risk_level": "GREEN"}
    assert _epoch() != epoch

    hist = demo_data.build_demo_mother_history(today_ist())
    visits = _visits()
    assert [v.id for v in visits] == demo_data.DEMO_VISIT_IDS
    assert [v.visit_date for v in visits] == [dv.visit_date for dv in hist.visits]
    assert _active_flags() == {}
    assert all(a.status == AlertStatus.closed.value for a in _alerts())

    with db.SessionLocal() as s:
        mother = s.get(Mother, MID)
        t = s.get(Task, task["id"])
        history = s.execute(
            select(RiskFlag).where(RiskFlag.mother_id == MID, RiskFlag.code == "HB_SEVERE")
        ).scalars().all()
    assert mother.risk_level == "GREEN" and mother.status == "active"
    assert mother.lmp_date == hist.lmp_date
    assert t.status == TaskStatus.cancelled.value  # cancelled, never deleted
    # Flag history survives the visit delete (source_visit_id SET NULL).
    assert len(history) == 1 and not history[0].active and history[0].source_visit_id is None


def test_reset_is_rerunnable_and_demo_can_run_again(client, doctor, demo_on):
    _trigger(client, doctor)
    epochs = {_epoch()}
    for _ in range(2):
        assert _reset(client, doctor)["risk_level"] == "GREEN"
        epochs.add(_epoch())
    assert len(epochs) == 3

    again = _trigger(client, doctor)
    assert again["risk_level"] == "RED" and again["alert_id"] is not None
    assert [a.id for a in _live_red()] == [again["alert_id"]]
