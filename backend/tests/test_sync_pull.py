"""GET /api/sync/pull end to end (Requirements 12.2-12.6, 44.2).

Every test drives the real HTTP route with an ASHA bearer token from the ``world``
fixture: facility ``a`` has villages[0] (``asha``) and villages[1] (``asha2``), one
GREEN mother per village (GA 120 days). Writes between pulls go through the push
route or short ``begin_write`` transactions, so every row carries a real Change_Seq.
"""
from __future__ import annotations

from datetime import timedelta
from typing import Any, Dict, Optional, Tuple

from app import db
from app.models import Task, new_uuid
from app.sync_service import read_counter
from app.timeutil import iso_z, today_ist, utcnow

PULL = "/api/sync/pull"
PUSH = "/api/sync/push"
DEVICE_ID = "22222222-3333-4444-8555-666666666666"


# --------------------------------------------------------------------------- helpers


def _pull(client, headers, since: Optional[str] = None, expect: int = 200) -> Dict[str, Any]:
    params = {} if since is None else {"since": since}
    resp = client.get(PULL, params=params, headers=headers)
    assert resp.status_code == expect, resp.text
    return resp.json()


def _counter() -> Tuple[int, str]:
    with db.SessionLocal() as s:
        return read_counter(s)


def _ids(rows) -> set:
    return {r["id"] for r in rows}


def _push(client, headers, *changes: Dict[str, Any]) -> None:
    resp = client.post(PUSH, json={"device_id": DEVICE_ID, "changes": list(changes)}, headers=headers)
    assert resp.status_code == 200, resp.text
    assert all(r["status"] == "applied" for r in resp.json()["results"]), resp.json()


def _mother_change(village_id: str) -> Dict[str, Any]:
    at = iso_z(utcnow() - timedelta(hours=1))
    return {
        "entity": "mother",
        "op": "upsert",
        "data": dict(
            id=new_uuid(),
            full_name="Pull Test Mother",
            age=26,
            guardian_name="Pull Test Guardian",
            village_id=village_id,
            lmp_date=(today_ist() - timedelta(days=70)).isoformat(),
            is_bpl=True,
            height_cm=155.0,
            first_weight_kg=52.0,
            registered_at=at,
            updated_at=at,
        ),
    }


def _green_visit_change(mother_id: str) -> Dict[str, Any]:
    """A visit with normal readings (no RED/AMBER rule fires on it alone)."""
    return {
        "entity": "visit",
        "op": "create",
        "data": dict(
            id=new_uuid(),
            mother_id=mother_id,
            visit_date=today_ist().isoformat(),
            weight_kg=58.0,
            weight_source="manual",
            hb_gdl=11.8,
            hb_source="manual",
            bp_systolic=112,
            bp_diastolic=72,
            bp_source="manual",
            client_created_at=iso_z(utcnow() - timedelta(minutes=5)),
        ),
    }


def _make_task(mother, doctor, asha, due_in_days: int = 2) -> str:
    with db.SessionLocal() as s:
        seq = db.begin_write(s)
        task = Task(
            id=new_uuid(),
            mother_id=mother.id,
            issued_by_id=doctor.id,
            asha_id=asha.id,
            action_type="HOME_VISIT_48H",
            instructions="Visit within 48 hours",
            due_date=today_ist() + timedelta(days=due_in_days),
            status="open",
            change_seq=seq,
        )
        s.add(task)
        s.commit()
        return task.id


def _bump_counter(times: int) -> None:
    for _ in range(times):
        with db.SessionLocal() as s:
            db.begin_write(s)
            s.commit()


# --------------------------------------------------------------------------- full snapshot


def test_full_snapshot_for_since_zero_missing_and_empty(client, world, auth_headers):
    fw = world.a
    headers = auth_headers(fw.asha)
    mine = fw.mothers_in(fw.villages[0])[0]
    overdue_id = _make_task(mine, fw.doctor, fw.asha, due_in_days=-1)
    upper, epoch = _counter()

    bodies = [_pull(client, headers, "0"), _pull(client, headers), _pull(client, headers, "")]
    for body in bodies:
        assert body["reset"] is False  # Req 12.2
        assert body["cursor"] == f"{epoch}:{upper}"
        assert body["server_time"].endswith("Z")
        assert _ids(body["villages"]) == {fw.villages[0].id}
        assert _ids(body["mothers"]) == {mine.id}
        assert _ids(body["tasks"]) == {overdue_id}
        assert body["visits"] == []
    # The three spellings of "full snapshot" return the same rows.
    assert bodies[0]["mothers"] == bodies[1]["mothers"] == bodies[2]["mothers"]

    # Server-owned mother fields and task fields are serialized (Req 12.7, 12.9, 12.10).
    [m] = bodies[0]["mothers"]
    assert m["risk_level"] == "GREEN" and m["status"] == "active"
    assert m["edd_date"] == mine.edd_date.isoformat()
    assert m["flags"] == [] and "risk_updated_at" in m
    [t] = bodies[0]["tasks"]
    assert t["is_overdue"] is True and t["status"] == "open"
    assert t["issued_by_id"] == fw.doctor.id and t["issued_by_name"] == fw.doctor.full_name
    assert t["asha_id"] == fw.asha.id


# --------------------------------------------------------------------------- incremental


def test_incremental_pull_returns_only_rows_changed_since_cursor(client, world, auth_headers):
    fw = world.a
    headers = auth_headers(fw.asha)
    old_mother = fw.mothers_in(fw.villages[0])[0]

    first = _pull(client, headers, "0")
    assert _ids(first["mothers"]) == {old_mother.id}

    new_mother = _mother_change(fw.villages[0].id)
    visit = _green_visit_change(old_mother.id)
    _push(client, headers, new_mother, visit)
    task_id = _make_task(old_mother, fw.doctor, fw.asha)
    upper, epoch = _counter()

    second = _pull(client, headers, first["cursor"])
    assert second["reset"] is False
    assert second["cursor"] == f"{epoch}:{upper}"
    assert int(second["cursor"].split(":")[1]) > int(first["cursor"].split(":")[1])
    # Only the rows written after the first cursor; the untouched mother is absent.
    assert new_mother["data"]["id"] in _ids(second["mothers"])
    assert old_mother.id not in _ids(second["mothers"])
    assert _ids(second["visits"]) == {visit["data"]["id"]}
    assert _ids(second["tasks"]) == {task_id}

    # Visit rows carry the server-added fields (Req 12.8).
    [v] = second["visits"]
    assert v["recorded_by_id"] == fw.asha.id
    assert v["device_id"] == DEVICE_ID
    assert v["received_at"].endswith("Z")
    assert v["weight_kg"] == 58.0 and v["hb_gdl"] == 11.8


def test_empty_incremental_pull_still_returns_villages_and_cursor(client, world, auth_headers):
    fw = world.a
    headers = auth_headers(fw.asha)
    first = _pull(client, headers, "0")

    again = _pull(client, headers, first["cursor"])
    assert again["reset"] is False
    assert again["mothers"] == [] and again["visits"] == [] and again["tasks"] == []
    assert _ids(again["villages"]) == {fw.villages[0].id}  # always sent (Req 12.6)
    assert again["cursor"] == first["cursor"]  # nothing was written in between
    assert again["server_time"].endswith("Z")

    # Writes outside the caller's scope advance the cursor but return no rows.
    _make_task(fw.mothers_in(fw.villages[1])[0], fw.doctor, fw.asha2)
    upper, epoch = _counter()
    later = _pull(client, headers, again["cursor"])
    assert later["cursor"] == f"{epoch}:{upper}" != again["cursor"]
    assert later["mothers"] == [] and later["visits"] == [] and later["tasks"] == []
    assert _ids(later["villages"]) == {fw.villages[0].id}


# --------------------------------------------------------------------------- reset


def test_reset_for_previous_epoch_cursor_and_cursor_ahead_of_counter(client, world, auth_headers):
    fw = world.a
    headers = auth_headers(fw.asha)
    mine = fw.mothers_in(fw.villages[0])[0]
    first = _pull(client, headers, "0")
    old_epoch, old_seq = first["cursor"].split(":")

    # Rotate the epoch (as a delete path would) and keep writing.
    with db.SessionLocal() as s:
        db.begin_write(s)
        new_epoch = db.rotate_epoch(s)
        s.commit()
    assert new_epoch != old_epoch
    upper, epoch = _counter()
    assert epoch == new_epoch and int(old_seq) <= upper

    body = _pull(client, headers, first["cursor"])
    assert body["reset"] is True  # Req 12.4: foreign epoch
    assert body["cursor"] == f"{new_epoch}:{upper}"
    assert _ids(body["mothers"]) == {mine.id}  # full snapshot, not an increment
    assert _ids(body["villages"]) == {fw.villages[0].id}

    # A current-epoch cursor whose seq is past the counter is also a reset.
    ahead = _pull(client, headers, f"{new_epoch}:{upper + 1}")
    assert ahead["reset"] is True
    assert _ids(ahead["mothers"]) == {mine.id}
    assert ahead["cursor"] == f"{new_epoch}:{upper}"

    # The fresh cursor works incrementally again.
    fresh = _pull(client, headers, body["cursor"])
    assert fresh["reset"] is False and fresh["mothers"] == []


def test_reset_after_reseed_even_when_new_counter_passes_old_seq(client, world, factory, auth_headers):
    old = world.a
    old_cursor = _pull(client, auth_headers(old.asha), "0")["cursor"]
    old_epoch, old_seq = old_cursor.split(":")

    # Reseed: drop and recreate every table (new SyncCounter row, new epoch), then
    # write more than the old database ever did.
    db.Base.metadata.drop_all(bind=db.engine)
    db.init_db()
    fresh = factory.facility_world("r")
    _bump_counter(int(old_seq) + 5)
    upper, epoch = _counter()
    assert epoch != old_epoch
    assert upper > int(old_seq)  # the old seq alone would look like a valid position

    headers = auth_headers(fresh.asha)
    body = _pull(client, headers, old_cursor)
    assert body["reset"] is True  # epoch differs (Req 12.4)
    assert body["cursor"] == f"{epoch}:{upper}"
    assert _ids(body["mothers"]) == {fresh.mothers_in(fresh.villages[0])[0].id}
    assert _ids(body["villages"]) == {fresh.villages[0].id}


# --------------------------------------------------------------------------- invalid cursor


def test_invalid_cursor_returns_400(client, world, auth_headers):
    headers = auth_headers(world.a.asha)
    _upper, epoch = _counter()
    bad = [
        "abc",
        "1",
        "-1",
        f"{epoch}",
        f"{epoch}:",
        f"{epoch}:-1",
        f"{epoch}:1.5",
        f"{epoch}:12a",
        f"{epoch}:1:2",
        f"{epoch}:{'9' * 19}",
        f"{epoch.upper()}:1",
        f"{epoch[:-1]}:1",
        f":{epoch}",
        f" {epoch}:1",
    ]
    for since in bad:
        resp = client.get(PULL, params={"since": since}, headers=headers)
        assert resp.status_code == 400, since
        assert resp.json() == {
            "detail": {"code": "INVALID_CURSOR", "message": "Unrecognised sync cursor"}
        }, since


# --------------------------------------------------------------------------- scope


def test_asha_sees_only_her_villages_and_tasks(client, world, factory, auth_headers):
    fw = world.a
    # A cross-facility assignment is filtered out of her villages (Req 5.7).
    factory.assign(fw.asha, world.b.villages[0])
    mine = fw.mothers_in(fw.villages[0])[0]
    theirs = fw.mothers_in(fw.villages[1])[0]
    my_task = _make_task(mine, fw.doctor, fw.asha)
    # Assigned to asha2, even though the mother is in asha's village.
    _make_task(mine, fw.doctor, fw.asha2)
    _make_task(theirs, fw.doctor, fw.asha2)
    _push(client, auth_headers(fw.asha2), _green_visit_change(theirs.id))

    body = _pull(client, auth_headers(fw.asha), "0")
    assert _ids(body["villages"]) == {fw.villages[0].id}
    assert _ids(body["mothers"]) == {mine.id}
    assert all(m["village_id"] == fw.villages[0].id for m in body["mothers"])
    assert body["visits"] == []
    assert _ids(body["tasks"]) == {my_task}

    other = _pull(client, auth_headers(fw.asha2), "0")
    assert _ids(other["villages"]) == {fw.villages[1].id}
    assert _ids(other["mothers"]) == {theirs.id}
    assert len(other["visits"]) == 1 and other["visits"][0]["mother_id"] == theirs.id
    assert len(other["tasks"]) == 2 and all(t["asha_id"] == fw.asha2.id for t in other["tasks"])


def test_co_asha_green_visit_appears_in_incremental_pull(client, world, factory, auth_headers):
    fw = world.a
    # asha2 shares asha's village.
    factory.assign(fw.asha2, fw.villages[0])
    mother = fw.mothers_in(fw.villages[0])[0]
    headers = auth_headers(fw.asha)
    first = _pull(client, headers, "0")

    visit = _green_visit_change(mother.id)
    _push(client, auth_headers(fw.asha2), visit)

    body = _pull(client, headers, first["cursor"])
    assert body["reset"] is False
    assert _ids(body["visits"]) == {visit["data"]["id"]}
    [v] = body["visits"]
    assert v["mother_id"] == mother.id and v["recorded_by_id"] == fw.asha2.id
    # Her mother row did not change (GREEN reading), yet the visit is delivered (Req 12.5).
    assert body["mothers"] == []


def test_pull_requires_asha_role(client, world, auth_headers):
    assert client.get(PULL, headers=auth_headers(world.a.doctor)).status_code == 403
    assert client.get(PULL, headers=auth_headers(world.a.anm)).status_code == 403
    assert client.get(PULL).status_code == 401
