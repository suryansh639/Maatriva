"""POST /api/sync/push end to end (Requirements 7.4, 7.6, 8.2, 8.5, 8.6, 9.3-9.5,
10.2, 44.2).

Every test drives the real HTTP route with an ASHA bearer token from the ``world``
fixture: facility ``a`` has villages[0] (``asha``) and villages[1] (``asha2``), one
GREEN mother per village (GA 120 days).
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Any, Dict, List, Optional

from app import db
from app.models import Mother, Task, Visit, new_uuid
from app.timeutil import iso_z, today_ist, utcnow

PUSH = "/api/sync/push"
DEVICE_ID = "11111111-2222-4333-8444-555555555555"


# --------------------------------------------------------------------------- helpers


def _push(client, headers, *changes: Dict[str, Any], device_id: str = DEVICE_ID):
    return client.post(PUSH, json={"device_id": device_id, "changes": list(changes)}, headers=headers)


def _results(resp) -> List[Dict[str, Any]]:
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert isinstance(body["server_time"], str) and body["server_time"].endswith("Z")
    return body["results"]


def mother_change(village_id: str, mid: Optional[str] = None, **over: Any) -> Dict[str, Any]:
    now = utcnow()
    lmp = today_ist() - timedelta(days=70)
    data = dict(
        id=mid or new_uuid(),
        full_name="Test Mother New",
        age=24,
        guardian_name="Test Guardian New",
        village_id=village_id,
        phone=None,
        lmp_date=lmp.isoformat(),
        is_bpl=False,
        height_cm=156.0,
        first_weight_kg=50.0,
        registered_at=iso_z(now - timedelta(hours=1)),
        updated_at=iso_z(now - timedelta(hours=1)),
    )
    data.update(over)
    return {"entity": "mother", "op": "upsert", "data": data}


def mother_change_from(m: Mother, **over: Any) -> Dict[str, Any]:
    """An upsert of a stored mother with her current client fields."""
    data = dict(
        id=m.id,
        full_name=m.full_name,
        age=m.age,
        guardian_name=m.guardian_name,
        village_id=m.village_id,
        phone=m.phone,
        lmp_date=m.lmp_date.isoformat(),
        is_bpl=m.is_bpl,
        height_cm=m.height_cm,
        first_weight_kg=m.first_weight_kg,
        registered_at=iso_z(m.registered_at),
        updated_at=iso_z(m.updated_at),
    )
    data.update(over)
    return {"entity": "mother", "op": "upsert", "data": data}


def visit_change(mother_id: str, vid: Optional[str] = None, **over: Any) -> Dict[str, Any]:
    data = dict(
        id=vid or new_uuid(),
        mother_id=mother_id,
        visit_date=today_ist().isoformat(),
        weight_kg=55.0,
        weight_source="manual",
        hb_gdl=11.5,
        hb_source="manual",
        bp_systolic=112,
        bp_diastolic=72,
        bp_source="manual",
        client_created_at=iso_z(utcnow() - timedelta(minutes=5)),
    )
    data.update(over)
    return {"entity": "visit", "op": "create", "data": data}


def task_change(task_id: str, note: Optional[str] = "done", **over: Any) -> Dict[str, Any]:
    data = dict(id=task_id, done_at=iso_z(utcnow() - timedelta(minutes=1)), done_note=note)
    data.update(over)
    return {"entity": "task", "op": "complete", "data": data}


def make_task(mother: Mother, doctor, asha, status: str = "open") -> str:
    """Insert a task directly (the task-creation endpoint comes later)."""
    with db.SessionLocal() as s:
        seq = db.begin_write(s)
        task = Task(
            id=new_uuid(),
            mother_id=mother.id,
            issued_by_id=doctor.id,
            asha_id=asha.id,
            action_type="HOME_VISIT_48H",
            instructions="Visit within 48 hours",
            due_date=today_ist() + timedelta(days=2),
            status=status,
            change_seq=seq,
        )
        s.add(task)
        s.commit()
        return task.id


def _get(model, rid: str):
    with db.SessionLocal() as s:
        row = s.get(model, rid)
        if row is not None:
            s.expunge(row)
        return row


def _error_code(result: Dict[str, Any]) -> Optional[str]:
    return result["error"]["code"] if result["error"] else None


# --------------------------------------------------------------------------- mother upsert


def test_mother_insert_applied_then_duplicate_push_is_stale(client, world, auth_headers):
    fw = world.a
    headers = auth_headers(fw.asha)
    change = mother_change(fw.villages[0].id, risk_level="RED", status="delivered",
                           asha_id=fw.asha2.id, edd_date="2030-01-01")

    [r] = _results(_push(client, headers, change))
    assert r == {"entity": "mother", "id": change["data"]["id"], "status": "applied", "error": None}

    stored = _get(Mother, change["data"]["id"])
    # Server-owned fields come from the server, not the client (Req 8.1, 8.3).
    assert stored.asha_id == fw.asha.id
    assert stored.facility_id == fw.facility.id
    assert stored.status == "active" and stored.risk_level == "GREEN"
    assert stored.edd_date != date(2030, 1, 1)
    first_seq = stored.change_seq

    # Re-sending the same upsert (equal updated_at) is stale and writes nothing.
    [r2] = _results(_push(client, headers, change))
    assert r2["status"] == "stale" and r2["error"] is None
    assert _get(Mother, change["data"]["id"]).change_seq == first_seq


def test_mother_newer_update_applied_and_older_stale(client, world, factory, auth_headers):
    fw = world.a
    # asha also covers village 2 so she may edit asha2's mother; asha_id must stay asha2.
    factory.assign(fw.asha, fw.villages[1])
    mother = fw.mothers_in(fw.villages[1])[0]
    headers = auth_headers(fw.asha)
    before = _get(Mother, mother.id)

    newer_at = utcnow() - timedelta(minutes=1)
    new_lmp = mother.lmp_date - timedelta(days=3)
    newer = mother_change_from(
        mother,
        full_name="Test Mother Edited",
        village_id=fw.villages[0].id,
        lmp_date=new_lmp.isoformat(),
        updated_at=iso_z(newer_at),
    )
    [r] = _results(_push(client, headers, newer))
    assert r["status"] == "applied"

    after = _get(Mother, mother.id)
    assert after.full_name == "Test Mother Edited"
    assert after.village_id == fw.villages[0].id
    assert after.lmp_date == new_lmp
    assert after.edd_date != before.edd_date  # recomputed from the new LMP
    assert after.updated_at == newer_at
    assert after.asha_id == fw.asha2.id  # original owner kept (Req 8.5)
    assert after.change_seq > before.change_seq

    # An older edit loses: stale, row untouched (Req 8.6).
    older = mother_change_from(
        mother, full_name="Test Mother Old Edit", updated_at=iso_z(newer_at - timedelta(hours=2))
    )
    [r2] = _results(_push(client, headers, older))
    assert r2["status"] == "stale"
    unchanged = _get(Mother, mother.id)
    assert unchanged.full_name == "Test Mother Edited"
    assert unchanged.change_seq == after.change_seq


def test_mother_out_of_scope_for_new_and_stored_village(client, world, auth_headers):
    fw = world.a
    headers = auth_headers(fw.asha)

    # New mother in a village the caller does not cover (asha2's village).
    new_change = mother_change(fw.villages[1].id)
    # Same facility's other village, and another facility's village.
    other_fac = mother_change(world.b.villages[0].id)
    # Stored mother in asha2's village, moved into the caller's village.
    stored = fw.mothers_in(fw.villages[1])[0]
    hijack = mother_change_from(
        stored, village_id=fw.villages[0].id, full_name="Hijacked",
        updated_at=iso_z(utcnow() - timedelta(minutes=1)),
    )

    results = _results(_push(client, headers, new_change, other_fac, hijack))
    assert [r["status"] for r in results] == ["rejected"] * 3
    assert [_error_code(r) for r in results] == ["OUT_OF_SCOPE"] * 3
    assert [r["id"] for r in results] == [
        new_change["data"]["id"], other_fac["data"]["id"], stored.id
    ]

    assert _get(Mother, new_change["data"]["id"]) is None
    assert _get(Mother, other_fac["data"]["id"]) is None
    kept = _get(Mother, stored.id)
    assert kept.village_id == fw.villages[1].id and kept.full_name == stored.full_name


# --------------------------------------------------------------------------- per-change isolation


def test_malformed_change_rejected_while_others_apply(client, world, auth_headers):
    fw = world.a
    headers = auth_headers(fw.asha)
    good_mother = mother_change(fw.villages[0].id)
    bad_mother = mother_change(fw.villages[0].id, age=5)
    good_visit = visit_change(fw.mothers_in(fw.villages[0])[0].id)

    results = _results(_push(client, headers, good_mother, bad_mother, good_visit))
    assert [r["status"] for r in results] == ["applied", "rejected", "applied"]
    bad = results[1]
    assert bad["id"] == bad_mother["data"]["id"]
    assert bad["error"]["code"] == "VALIDATION_ERROR"
    assert bad["error"]["message"].startswith("age:")

    assert _get(Mother, good_mother["data"]["id"]) is not None
    assert _get(Mother, bad_mother["data"]["id"]) is None
    visit = _get(Visit, good_visit["data"]["id"])
    assert visit is not None
    assert visit.recorded_by_id == fw.asha.id
    assert visit.device_id == DEVICE_ID


def test_results_index_aligned_with_null_id_for_unparseable_id(client, world, auth_headers):
    fw = world.a
    headers = auth_headers(fw.asha)
    upper_id = str(uuid.uuid4()).upper()
    changes = [
        mother_change(fw.villages[0].id, mid="not-a-uuid"),
        {"entity": "baby", "op": "upsert", "data": {"id": upper_id}},
        {"entity": "mother", "op": "delete", "data": {}},
        mother_change(fw.villages[0].id, mid=upper_id),
        visit_change(fw.mothers_in(fw.villages[0])[0].id, vid=12345),
    ]
    results = _results(_push(client, headers, *changes))

    assert len(results) == len(changes)
    assert [r["entity"] for r in results] == ["mother", "baby", "mother", "mother", "visit"]
    assert [r["id"] for r in results] == [None, upper_id.lower(), None, upper_id.lower(), None]
    assert [r["status"] for r in results] == [
        "rejected", "rejected", "rejected", "applied", "rejected"
    ]
    assert [_error_code(r) for r in results] == [
        "VALIDATION_ERROR", "UNKNOWN_ENTITY", "UNKNOWN_ENTITY", None, "VALIDATION_ERROR"
    ]
    # The uppercase id is stored lowercase (Req 11.1).
    assert _get(Mother, upper_id.lower()) is not None


# --------------------------------------------------------------------------- visit create


def test_visit_duplicate_and_conflict(client, world, factory, auth_headers):
    fw = world.a
    headers = auth_headers(fw.asha)
    m1 = fw.mothers_in(fw.villages[0])[0]
    m2 = factory.mother(fw.villages[0], fw.asha)
    vid = new_uuid()

    [r1] = _results(_push(client, headers, visit_change(m1.id, vid=vid)))
    assert r1["status"] == "applied"
    original = _get(Visit, vid)

    # Same id, same mother: duplicate, never updated (Req 9.3, 9.7).
    [r2] = _results(_push(client, headers, visit_change(m1.id, vid=vid, weight_kg=60.0)))
    assert r2 == {"entity": "visit", "id": vid, "status": "duplicate", "error": None}
    again = _get(Visit, vid)
    assert again.weight_kg == original.weight_kg == 55.0
    assert again.change_seq == original.change_seq

    # Same id, different mother: CONFLICT (Req 9.4).
    [r3] = _results(_push(client, headers, visit_change(m2.id, vid=vid)))
    assert r3["status"] == "rejected" and _error_code(r3) == "CONFLICT"
    assert _get(Visit, vid).mother_id == m1.id


def test_visit_mother_inactive_and_duplicate_ahead_of_delivered(client, world, auth_headers):
    fw = world.a
    headers = auth_headers(fw.asha)
    mother = fw.mothers_in(fw.villages[0])[0]
    vid = new_uuid()
    [r1] = _results(_push(client, headers, visit_change(mother.id, vid=vid)))
    assert r1["status"] == "applied"

    with db.SessionLocal() as s:
        seq = db.begin_write(s)
        row = s.get(Mother, mother.id)
        row.status = "delivered"
        row.change_seq = seq
        s.commit()

    new_vid = new_uuid()
    retry, fresh = _results(
        _push(client, headers, visit_change(mother.id, vid=vid), visit_change(mother.id, vid=new_vid))
    )
    assert retry["status"] == "duplicate"  # duplicate check runs before delivered (Req 9.3)
    assert fresh["status"] == "rejected" and _error_code(fresh) == "MOTHER_INACTIVE"
    assert _get(Visit, new_vid) is None


def test_visit_unknown_and_out_of_scope_mother(client, world, auth_headers):
    fw = world.a
    headers = auth_headers(fw.asha)
    other = fw.mothers_in(fw.villages[1])[0]
    missing, out = _results(
        _push(client, headers, visit_change(new_uuid()), visit_change(other.id))
    )
    assert _error_code(missing) == "MOTHER_NOT_FOUND"
    assert _error_code(out) == "OUT_OF_SCOPE"


# --------------------------------------------------------------------------- task complete


def test_task_completion_is_idempotent(client, world, auth_headers):
    fw = world.a
    headers = auth_headers(fw.asha)
    mother = fw.mothers_in(fw.villages[0])[0]
    task_id = make_task(mother, fw.doctor, fw.asha)
    before = _get(Task, task_id)

    first = task_change(task_id, note="Visited, counselled")
    [r1] = _results(_push(client, headers, first))
    assert r1 == {"entity": "task", "id": task_id, "status": "applied", "error": None}
    done = _get(Task, task_id)
    assert done.status == "done" and done.done_note == "Visited, counselled"
    assert done.done_at is not None and done.change_seq > before.change_seq

    # Retrying (even with a different note) is a duplicate and changes nothing (Req 10.2).
    [r2] = _results(_push(client, headers, task_change(task_id, note="second try")))
    assert r2["status"] == "duplicate" and r2["error"] is None
    again = _get(Task, task_id)
    assert again.done_note == "Visited, counselled"
    assert again.done_at == done.done_at
    assert again.change_seq == done.change_seq


def test_task_not_found_and_cancelled(client, world, auth_headers):
    fw = world.a
    headers = auth_headers(fw.asha)
    other_task = make_task(fw.mothers_in(fw.villages[1])[0], fw.doctor, fw.asha2)
    cancelled = make_task(fw.mothers_in(fw.villages[0])[0], fw.doctor, fw.asha, status="cancelled")

    absent, not_mine, canc = _results(
        _push(client, headers, task_change(new_uuid()), task_change(other_task), task_change(cancelled))
    )
    assert _error_code(absent) == "TASK_NOT_FOUND"
    assert _error_code(not_mine) == "TASK_NOT_FOUND"
    assert absent["error"]["message"] == not_mine["error"]["message"]  # no existence leak
    assert _error_code(canc) == "TASK_CANCELLED"
    assert _get(Task, other_task).status == "open"


# --------------------------------------------------------------------------- envelope


def test_invalid_envelope_returns_422(client, world, auth_headers):
    headers = auth_headers(world.a.asha)
    valid = mother_change(world.a.villages[0].id)
    bodies = [
        {"device_id": DEVICE_ID, "changes": []},
        {"device_id": "not-a-uuid", "changes": [valid]},
        {"changes": [valid]},
        {"device_id": DEVICE_ID, "changes": [valid] * 201},
        {"device_id": DEVICE_ID, "changes": [{"entity": "mother", "op": "upsert"}]},
        {"device_id": DEVICE_ID, "changes": [{"entity": 1, "op": "upsert", "data": {}}]},
        {"device_id": DEVICE_ID, "changes": [{"entity": "mother", "op": "upsert", "data": []}]},
    ]
    for body in bodies:
        resp = client.post(PUSH, json=body, headers=headers)
        assert resp.status_code == 422, body
        assert isinstance(resp.json()["detail"], list)
    # Nothing from the rejected envelopes reached the database.
    assert _get(Mother, valid["data"]["id"]) is None


def test_push_requires_asha_role(client, world, auth_headers):
    change = mother_change(world.a.villages[0].id)
    assert _push(client, auth_headers(world.a.doctor), change).status_code == 403
    assert _push(client, {}, change).status_code == 401
