"""Dashboard census and queue, mock SMS log and AMBER digest (Requirements 17.4,
20.1, 21.1–21.3, 25.1, 25.2).

The pure ``build_census`` / ``sort_queue`` are checked on plain objects with a
fixed "today"; the routes go through the HTTP client on factory data, with
risk produced by the ``add_visit``/``triage`` helpers.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from types import SimpleNamespace
from typing import List

import pytest
from sqlalchemy import select

from app import db, notifications
from app.dashboard_service import build_census, sort_queue
from app.models import Alert, Mother, NotificationKind, NotificationOutbox, User
from app.schemas import QueueRowOut
from app.timeutil import today_ist, utcnow
from tests.test_alerts import alerts
from tests.test_tasks import body as task_body
from tests.test_triage_service import add_visit, flags, triage


@pytest.fixture
def fw(world):
    return world.a


def mark_delivered(mother: Mother) -> None:
    with db.SessionLocal() as s:
        seq = db.begin_write(s)
        row = s.get(Mother, mother.id)
        row.status, row.change_seq = "delivered", seq
        s.commit()


def make_red(mother: Mother, hb: float = 6.5, now: datetime = None) -> None:
    add_visit(mother, hb=hb)
    triage(mother.id, now)


# --------------------------------------------------------------------------- census (pure)


def test_build_census_counts_active_mothers_only():
    today = date(2025, 3, 15)
    fac = SimpleNamespace(id="f", name="PHC")
    villages = [
        SimpleNamespace(id="v1", name="One", lat=28.1, lng=77.1),
        SimpleNamespace(id="v2", name="Two", lat=28.2, lng=77.2),
        SimpleNamespace(id="v3", name="Empty", lat=28.3, lng=77.3),
    ]

    def m(village, ga, risk, edd, bpl=False, status="active"):
        return SimpleNamespace(
            village_id=village,
            status=status,
            is_bpl=bpl,
            lmp_date=today - timedelta(days=ga),
            edd_date=edd,
            risk_level=risk,
        )

    mothers = [
        m("v1", 50, "RED", date(2025, 10, 31), bpl=True),  # T1
        m("v1", 150, "AMBER", date(2025, 3, 20)),  # T2, due
        m("v2", 260, "GREEN", date(2025, 3, 1), bpl=True),  # T3, due
        m("v2", 98, "GREEN", date(2025, 4, 1)),  # T2 boundary, not due
        m("v2", 200, "RED", date(2025, 3, 10), bpl=True, status="delivered"),  # excluded
    ]
    out = build_census(fac, villages, mothers, today)

    assert out.facility.id == "f" and out.as_of == today
    assert (out.total_pregnant, out.bpl_count, out.due_this_month) == (4, 2, 2)
    assert (out.by_trimester.t1, out.by_trimester.t2, out.by_trimester.t3) == (1, 2, 1)
    assert (out.risk_counts.red, out.risk_counts.amber, out.risk_counts.green) == (1, 1, 2)
    rows = {v.id: v for v in out.villages}
    assert [v.id for v in out.villages] == ["v1", "v2", "v3"]
    one, two, empty = rows["v1"], rows["v2"], rows["v3"]
    assert (one.pregnant, one.bpl, one.red, one.amber, one.green, one.due_this_month) == (2, 1, 1, 1, 0, 1)
    assert (two.pregnant, two.bpl, two.red, two.amber, two.green, two.due_this_month) == (2, 1, 0, 0, 2, 1)
    assert (empty.pregnant, empty.lat, empty.lng) == (0, 28.3, 77.3)


# --------------------------------------------------------------------------- census (route)


def test_census_route(client, world, factory, auth_headers):
    fw = world.a
    v0, v1 = fw.villages
    red = fw.mothers_in(v0)[0]
    make_red(red)
    early = factory.mother(v0, fw.asha, ga=50, is_bpl=True)
    gone = factory.mother(v1, fw.asha2, ga=250, is_bpl=True)
    mark_delivered(gone)

    resp = client.get("/api/dashboard/census", headers=auth_headers(fw.doctor))
    assert resp.status_code == 200, resp.text
    out = resp.json()
    today = today_ist()
    active = fw.mothers + [early]
    assert out["facility"] == {"id": fw.facility.id, "name": fw.facility.name}
    assert out["as_of"] == today.isoformat()
    assert out["total_pregnant"] == 3 and out["bpl_count"] == 1
    assert out["by_trimester"] == {"t1": 1, "t2": 2, "t3": 0}
    assert out["risk_counts"] == {"red": 1, "amber": 0, "green": 2}
    due = sum(1 for m in active if (m.edd_date.year, m.edd_date.month) == (today.year, today.month))
    assert out["due_this_month"] == due
    rows = {v["id"]: v for v in out["villages"]}
    assert set(rows) == {v0.id, v1.id}
    assert rows[v0.id]["pregnant"] == 2 and rows[v0.id]["red"] == 1 and rows[v0.id]["bpl"] == 1
    assert rows[v1.id]["pregnant"] == 1 and rows[v1.id]["green"] == 1
    assert (rows[v0.id]["lat"], rows[v0.id]["lng"]) == (v0.lat, v0.lng)

    # ANM reads the same facility census; facility B is unaffected.
    assert client.get("/api/dashboard/census", headers=auth_headers(fw.anm)).json() == out
    other = client.get("/api/dashboard/census", headers=auth_headers(world.b.doctor)).json()
    assert other["total_pregnant"] == 2 and other["risk_counts"]["red"] == 0


# --------------------------------------------------------------------------- queue (pure)


def _row(name: str, risk: str, updated: datetime = None, village: str = "v") -> QueueRowOut:
    return QueueRowOut(
        mother_id=f"id-{name}",
        full_name=name,
        guardian_name="g",
        village_id=village,
        village_name=village,
        is_bpl=False,
        ga_days=100,
        edd_date=date(2025, 9, 1),
        risk_level=risk,
        risk_updated_at=updated,
    )


def test_sort_queue_orders_by_risk_then_newest_then_name():
    t = datetime(2025, 3, 1, 8, 0)
    rows = [
        _row("g-null", "GREEN"),
        _row("a-old", "AMBER", t),
        _row("r-null", "RED"),
        _row("r-old", "RED", t),
        _row("r-new", "RED", t + timedelta(hours=1)),
        _row("b-tie", "AMBER", t + timedelta(hours=2), village="w"),
        _row("a-tie", "AMBER", t + timedelta(hours=2)),
    ]
    names = lambda rs: [r.full_name for r in rs]  # noqa: E731
    assert names(sort_queue(rows)) == ["r-new", "r-old", "r-null", "a-tie", "b-tie", "a-old", "g-null"]
    assert names(sort_queue(rows, risk="AMBER")) == ["a-tie", "b-tie", "a-old"]
    assert names(sort_queue(rows, village_id="w")) == ["b-tie"]
    assert sort_queue(rows, village_id="w", risk="RED") == []


# --------------------------------------------------------------------------- queue (route)


@pytest.fixture
def queue_world(world, factory):
    """r_new and r_old RED (r_new triaged later), amber, green, and a delivered
    mother that must not appear."""
    fw = world.a
    v0, v1 = fw.villages
    r_old = fw.mothers_in(v0)[0]
    amber = fw.mothers_in(v1)[0]
    r_new = factory.mother(v1, fw.asha2)
    green = factory.mother(v0, fw.asha)
    gone = factory.mother(v0, fw.asha)

    make_red(r_old, now=utcnow() - timedelta(minutes=10))
    make_red(r_new, hb=6.0)
    add_visit(amber, hb=9.0)
    triage(amber.id)
    add_visit(green, days_ago=1)
    triage(green.id)
    mark_delivered(gone)
    return SimpleNamespace(fw=fw, r_old=r_old, r_new=r_new, amber=amber, green=green, gone=gone)


def _queue(client, headers, query: str = "") -> List[dict]:
    resp = client.get(f"/api/dashboard/queue{query}", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_queue_order_and_row_fields(client, queue_world, auth_headers):
    q = queue_world
    headers = auth_headers(q.fw.doctor)
    resp = client.post(f"/api/mothers/{q.r_old.id}/tasks", json=task_body(), headers=headers)
    assert resp.status_code == 201

    rows = _queue(client, headers)
    assert [r["mother_id"] for r in rows] == [q.r_new.id, q.r_old.id, q.amber.id, q.green.id]
    assert [r["risk_level"] for r in rows] == ["RED", "RED", "AMBER", "GREEN"]

    row = rows[1]
    [alert] = alerts(q.r_old.id)
    assert row["full_name"] == q.r_old.full_name and row["guardian_name"] == q.r_old.guardian_name
    assert row["village_id"] == q.fw.villages[0].id
    assert row["village_name"] == q.fw.villages[0].name
    assert row["is_bpl"] is False and row["ga_days"] == 120
    assert row["edd_date"] == q.r_old.edd_date.isoformat()
    assert [f["code"] for f in row["flags"]] == ["HB_SEVERE"]
    assert row["flags"][0]["reason"] == "Hb 6.5 g/dL (<7.0): severe anaemia"
    assert row["last_visit_date"] == today_ist().isoformat()
    assert row["open_alert_id"] == alert.id and row["open_alert_status"] == "actioned"
    assert row["open_task_count"] == 1
    assert row["risk_updated_at"].endswith("Z")
    green = rows[3]
    assert green["open_alert_id"] is None and green["open_task_count"] == 0 and green["flags"] == []

    # The ANM reads the same queue.
    assert _queue(client, auth_headers(q.fw.anm)) == rows


def test_queue_filters(client, queue_world, auth_headers):
    q = queue_world
    headers = auth_headers(q.fw.doctor)
    v0, v1 = q.fw.villages
    ids = lambda rows: [r["mother_id"] for r in rows]  # noqa: E731

    assert ids(_queue(client, headers, "?risk=RED")) == [q.r_new.id, q.r_old.id]
    assert ids(_queue(client, headers, "?risk=AMBER")) == [q.amber.id]
    assert ids(_queue(client, headers, f"?village_id={v0.id}")) == [q.r_old.id, q.green.id]
    assert ids(_queue(client, headers, f"?village_id={v1.id.upper()}&risk=RED")) == [q.r_new.id]
    assert _queue(client, headers, f"?village_id={v1.id}&risk=GREEN") == []


@pytest.mark.parametrize("query", ["?risk=PURPLE", "?risk=red", "?village_id=nope", "?village_id=B"])
def test_queue_invalid_filter_is_422(client, world, auth_headers, query):
    if query.endswith("=B"):
        query = f"?village_id={world.b.villages[0].id}"  # another facility's village
    resp = client.get(f"/api/dashboard/queue{query}", headers=auth_headers(world.a.doctor))
    assert resp.status_code == 422, resp.text
    assert isinstance(resp.json()["detail"], list)  # FastAPI's default 422 body


# --------------------------------------------------------------------------- notifications


def _write_sms(facility_id: str, to_user: User, n: int, base: datetime) -> List[str]:
    ids = []
    with db.SessionLocal() as s:
        db.begin_write(s)
        for i in range(n):
            row = notifications.write(
                s,
                NotificationKind.task_assigned,
                facility_id,
                to_user,
                f"MAATRIVA TASK: test {i}",
                now=base + timedelta(minutes=i),
            )
            ids.append(row.id)
        s.commit()
    return ids


def test_notifications_newest_first_with_limit(client, world, auth_headers):
    fw = world.a
    base = utcnow() - timedelta(hours=1)
    ids = _write_sms(fw.facility.id, fw.asha, 5, base)
    _write_sms(world.b.facility.id, world.b.asha, 2, base)
    headers = auth_headers(fw.doctor)

    rows = client.get("/api/notifications", headers=headers).json()
    assert [r["id"] for r in rows] == ids[::-1]
    first = rows[0]
    assert first["channel"] == "sms" and first["status"] == "mock_sent"
    assert first["kind"] == "task_assigned" and first["body"] == "MAATRIVA TASK: test 4"
    assert (first["to_user_id"], first["to_username"], first["to_role"]) == (fw.asha.id, fw.asha.username, "asha")
    assert first["created_at"].endswith("Z")

    limited = client.get("/api/notifications?limit=3", headers=auth_headers(fw.anm))
    assert limited.status_code == 200
    assert [r["id"] for r in limited.json()] == ids[::-1][:3]
    assert client.get("/api/notifications?limit=200", headers=headers).status_code == 200
    for bad in ("0", "201", "x"):
        assert client.get(f"/api/notifications?limit={bad}", headers=headers).status_code == 422


def test_notifications_default_limit_is_50(client, fw, auth_headers):
    _write_sms(fw.facility.id, fw.asha, 55, utcnow() - timedelta(hours=2))
    rows = client.get("/api/notifications", headers=auth_headers(fw.doctor)).json()
    assert len(rows) == 50


# --------------------------------------------------------------------------- digest


@pytest.fixture
def digest_world(world, factory):
    fw = world.a
    v0, v1 = fw.villages
    amber1 = fw.mothers_in(v0)[0]
    amber2 = fw.mothers_in(v1)[0]
    red = factory.mother(v0, fw.asha)
    stale = factory.mother(v1, fw.asha2)
    for m, hb in ((amber1, 9.0), (amber2, 9.5), (red, 6.5), (stale, 9.2)):
        add_visit(m, hb=hb)
        triage(m.id)
    # An AMBER alert from 8 days ago falls outside the 7-day window.
    [old] = alerts(stale.id)
    with db.SessionLocal() as s:
        db.begin_write(s)
        s.get(Alert, old.id).created_at = utcnow() - timedelta(days=8)
        s.commit()
    b_mother = world.b.mothers[0]
    add_visit(b_mother, hb=9.0)
    triage(b_mother.id)
    return SimpleNamespace(fw=fw, amber1=amber1, amber2=amber2, red=red)


def test_digest_groups_open_amber_alerts_by_village(client, digest_world, auth_headers):
    d = digest_world
    v0, v1 = d.fw.villages
    resp = client.get("/api/digest", headers=auth_headers(d.fw.anm))
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["total"] == 2
    assert out["as_of"].endswith("Z") and out["since"].endswith("Z")
    assert [(g["village_id"], g["village_name"], g["count"]) for g in out["villages"]] == [
        (v0.id, v0.name, 1),
        (v1.id, v1.name, 1),
    ]
    item = out["villages"][0]["items"][0]
    [alert] = alerts(d.amber1.id)
    [flag] = flags(d.amber1.id, active=True)
    assert item["alert_id"] == alert.id and item["mother_id"] == d.amber1.id
    assert item["short_code"] == notifications.short_code(d.amber1.id)
    assert item["risk_level"] == "AMBER" and item["flag_codes"] == ["HB_MODERATE"]
    assert item["reasons"] == [flag.reason]
    assert out["villages"][1]["items"][0]["mother_id"] == d.amber2.id


def test_digest_send_writes_one_sms_per_anm(client, digest_world, factory, auth_headers):
    d = digest_world
    headers = auth_headers(d.fw.doctor)
    resp = client.post("/api/digest/send", headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"count": 1}

    with db.SessionLocal() as s:
        [row] = s.execute(
            select(NotificationOutbox).where(NotificationOutbox.kind == "amber_digest")
        ).scalars().all()
        assert row.to_user_id == d.fw.anm.id and row.facility_id == d.fw.facility.id
        v0, v1 = d.fw.villages
        assert row.body == f"MAATRIVA AMBER digest: {v0.name} 1; {v1.name} 1"
        assert d.amber1.full_name not in row.body and d.amber2.full_name not in row.body

    factory.user("anm", d.fw.facility, username="anm2_a")
    assert client.post("/api/digest/send", headers=auth_headers(d.fw.anm)).json() == {"count": 2}


def test_digest_send_without_anm_writes_nothing(client, factory, auth_headers):
    fac = factory.facility(name="PHC Lonely")
    doctor = factory.user("doctor", fac)
    resp = client.post("/api/digest/send", headers=auth_headers(doctor))
    assert resp.status_code == 200 and resp.json() == {"count": 0}
    empty = client.get("/api/digest", headers=auth_headers(doctor)).json()
    assert empty["total"] == 0 and empty["villages"] == []
