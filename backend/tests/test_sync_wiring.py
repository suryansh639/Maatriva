"""Push → triage → events wiring (Requirements 7.9, 7.10, 7.11, 10.4, 10.5, 18.6).

Drives the real ``POST /api/sync/push`` route. ``events.broker.publish`` is
replaced by a spy that records each event together with what a FRESH session
sees at publish time, which proves every event is published after its commit.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Tuple

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import OperationalError

from app import db, events, sync_service, triage_service
from app.models import Alert, Mother, NotificationOutbox, Task
from tests.test_sync_push import _get, _push, _results, make_task, task_change, visit_change


@pytest.fixture
def published(monkeypatch) -> List[Dict[str, Any]]:
    """Record every publish with the committed DB state seen at that moment."""
    seen: List[Dict[str, Any]] = []

    def spy(facility_id: str, event: str, data: Any, id: Any = None) -> None:
        with db.SessionLocal() as s:  # fresh session: sees committed rows only
            alerts = {a.id: a.status for a in s.execute(select(Alert)).scalars()}
            tasks = {t.id: t.status for t in s.execute(select(Task)).scalars()}
            risks = {m.id: m.risk_level for m in s.execute(select(Mother)).scalars()}
        seen.append(
            dict(facility_id=facility_id, event=event, data=data,
                 alerts=alerts, tasks=tasks, risks=risks)
        )

    monkeypatch.setattr(events.broker, "publish", spy)
    return seen


def _sms(kind: str) -> List[NotificationOutbox]:
    with db.SessionLocal() as s:
        rows = s.execute(select(NotificationOutbox).where(NotificationOutbox.kind == kind)).scalars().all()
        for r in rows:
            s.expunge(r)
        return list(rows)


def _red_visit(mother_id: str) -> Dict[str, Any]:
    return visit_change(mother_id, hb_gdl=6.5)  # HB_SEVERE (RED)


# --------------------------------------------------------------------------- triage after push


def test_red_visit_push_triages_and_publishes_after_commit(client, world, auth_headers, published):
    fw = world.a
    mother = fw.mothers_in(fw.villages[0])[0]

    [r] = _results(_push(client, auth_headers(fw.asha), _red_visit(mother.id)))
    assert r["status"] == "applied"

    assert _get(Mother, mother.id).risk_level == "RED"
    with db.SessionLocal() as s:
        alerts = s.execute(select(Alert).where(Alert.mother_id == mother.id)).scalars().all()
        assert [(a.severity, a.status) for a in alerts] == [("RED", "open")]
        alert_id = alerts[0].id
    # One red_alert SMS to the facility's doctor (Req 16.8).
    assert [n.to_user_id for n in _sms("red_alert")] == [fw.doctor.id]

    names = [e["event"] for e in published]
    assert names == ["alert.created", "risk.changed"]
    created, risk = published
    assert created["facility_id"] == fw.facility.id
    assert created["data"]["alert"]["id"] == alert_id
    # Published after the triage commit (Req 18.6).
    assert created["alerts"][alert_id] == "open"
    assert risk["data"] == {"mother_id": mother.id, "risk_level": "RED"}
    assert risk["risks"][mother.id] == "RED"


def test_duplicate_visit_retriages_without_new_alert(client, world, auth_headers, published):
    fw = world.a
    mother = fw.mothers_in(fw.villages[0])[0]
    headers = auth_headers(fw.asha)
    change = _red_visit(mother.id)
    _results(_push(client, headers, change))
    published.clear()

    [r] = _results(_push(client, headers, change))
    assert r["status"] == "duplicate"
    with db.SessionLocal() as s:
        n = s.execute(select(func.count()).select_from(Alert).where(Alert.mother_id == mother.id)).scalar_one()
    assert n == 1
    assert len(_sms("red_alert")) == 1
    assert published == []  # no-op rerun: nothing changed, nothing published


def test_triage_failure_keeps_200_and_logs_mother_id(
    client, world, auth_headers, published, monkeypatch, caplog
):
    fw = world.a
    mother = fw.mothers_in(fw.villages[0])[0]
    real = triage_service.apply_triage

    def boom(session, mother_id, now):
        if mother_id == mother.id:
            raise RuntimeError("triage exploded")
        return real(session, mother_id, now)

    monkeypatch.setattr(triage_service, "apply_triage", boom)
    caplog.set_level(logging.ERROR, logger="app.routers.sync")

    [r] = _results(_push(client, auth_headers(fw.asha), _red_visit(mother.id)))
    assert r["status"] == "applied"  # committed change kept (Req 7.11)
    assert _get(Mother, mother.id).risk_level == "GREEN"  # triage never committed
    errors = [rec for rec in caplog.records if rec.levelno >= logging.ERROR]
    assert any(mother.id in rec.getMessage() for rec in errors)
    assert published == []


def test_db_error_runs_best_effort_triage_then_503(
    client, world, auth_headers, published, monkeypatch
):
    fw = world.a
    mother = fw.mothers_in(fw.villages[0])[0]

    def failing_apply(*args, **kwargs):
        raise OperationalError("UPDATE task", {}, Exception("database is locked"))

    monkeypatch.setitem(
        sync_service.HANDLERS,
        ("task", "complete"),
        sync_service.Handler(sync_service.TaskCompleteIn, failing_apply),
    )
    task_id = make_task(mother, fw.doctor, fw.asha)

    resp = _push(client, auth_headers(fw.asha), _red_visit(mother.id), task_change(task_id))
    assert resp.status_code == 503
    assert resp.json()["detail"]["code"] == "DB_BUSY"

    # The visit committed before the error was triaged anyway (Req 7.10).
    assert _get(Mother, mother.id).risk_level == "RED"
    assert [e["event"] for e in published] == ["alert.created", "risk.changed"]


# --------------------------------------------------------------------------- task completion


def _open_red_alert_with_task(client, fw, auth_headers) -> Tuple[Mother, str, str]:
    mother = fw.mothers_in(fw.villages[0])[0]
    _results(_push(client, auth_headers(fw.asha), _red_visit(mother.id)))
    with db.SessionLocal() as s:
        alert = s.execute(select(Alert).where(Alert.mother_id == mother.id)).scalar_one()
        alert_id = alert.id
    task_id = make_task(mother, fw.doctor, fw.asha)
    with db.SessionLocal() as s:
        db.begin_write(s)
        s.get(Task, task_id).alert_id = alert_id
        s.get(Alert, alert_id).status = "actioned"
        s.commit()
    return mother, alert_id, task_id


def test_task_complete_closes_alert_writes_sms_and_publishes(
    client, world, auth_headers, published
):
    fw = world.a
    mother, alert_id, task_id = _open_red_alert_with_task(client, fw, auth_headers)
    published.clear()

    [r] = _results(_push(client, auth_headers(fw.asha), task_change(task_id)))
    assert r["status"] == "applied"

    assert _get(Alert, alert_id).status == "closed"
    assert _get(Alert, alert_id).closed_at is not None
    [sms] = _sms("task_done")
    assert sms.to_user_id == fw.doctor.id
    assert sms.related_task_id == task_id and sms.related_alert_id == alert_id
    assert sms.body == f"MAATRIVA DONE: Home visit within 48 hours for {mother.id[:6].upper()} by {fw.asha.username}."
    assert mother.full_name not in sms.body

    names = [e["event"] for e in published]
    assert names[:2] == ["task.done", "alert.updated"]
    done, updated = published[0], published[1]
    assert done["facility_id"] == fw.facility.id
    assert done["data"]["mother_name"] == mother.full_name
    assert done["data"]["task"]["id"] == task_id
    assert done["data"]["task"]["status"] == "done"
    assert done["data"]["task"]["mother_id"] == mother.id
    assert done["tasks"][task_id] == "done"  # published after commit
    assert updated["data"]["alert"]["id"] == alert_id
    assert updated["data"]["alert"]["status"] == "closed"
    assert updated["data"]["new_codes"] == []
    assert updated["alerts"][alert_id] == "closed"


def test_task_complete_with_other_open_task_keeps_alert(client, world, auth_headers, published):
    fw = world.a
    mother, alert_id, task_id = _open_red_alert_with_task(client, fw, auth_headers)
    other = make_task(mother, fw.doctor, fw.asha)
    with db.SessionLocal() as s:
        db.begin_write(s)
        s.get(Task, other).alert_id = alert_id
        s.commit()
    published.clear()

    _results(_push(client, auth_headers(fw.asha), task_change(task_id)))
    assert _get(Alert, alert_id).status == "actioned"
    assert [e["event"] for e in published] == ["task.done"]
    assert len(_sms("task_done")) == 1
