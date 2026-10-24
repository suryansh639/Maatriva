"""Property test for push idempotency (design Property 16).

Feature: maatriva-mvp, Property 16: Push idempotency

For any valid visit change, and for any completion of an open task assigned to the
caller, pushing the same change k times (k in 1..5, optionally with mutated payload
fields on the repeats, and optionally with the mother delivered between pushes)
yields ``applied`` first and ``duplicate`` afterwards. Exactly one stored row (or
one completion) results, and its fields equal the first push.

**Validates: Requirements 9.3, 9.6, 9.7, 10.2, 10.4**

Each iteration creates its own mother and task (fresh ids drawn from the
iteration rng) inside the shared per-test database, so iterations never touch each
other's rows. ``sync_service.push`` is called directly with a ``CurrentUser``.
"""
from __future__ import annotations

import random
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import func, select

from app import db, sync_service
from app.deps import load_current_user
from app.models import Alert, Mother, NotificationOutbox, Task, Visit
from app.schemas import PushIn, TaskCompleteIn, VisitIn
from app.timeutil import today_ist, utcnow
from tests.pbt import for_all

MOTHER_GA_DAYS = 120  # factory default: LMP 120 days before today (IST)

VISIT_COLUMNS = (
    "mother_id",
    "visit_date",
    "weight_kg",
    "weight_source",
    "ble_raw_hex",
    "hb_gdl",
    "hb_source",
    "bp_systolic",
    "bp_diastolic",
    "bp_source",
    "ifa_tablets",
    "calcium_tablets",
    "thr_received",
    "notes",
    "client_created_at",
)


# --------------------------------------------------------------------------- generators


def _rng_uuid(rng: random.Random) -> str:
    return str(uuid.UUID(int=rng.getrandbits(128), version=4))


def _iso_z(dt: datetime) -> str:
    return dt.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def _visit_fields(rng: random.Random) -> Dict[str, Any]:
    """A schema-valid visit body (without ``id`` / ``mother_id``)."""
    now = utcnow()
    fields: Dict[str, Any] = {
        # Within [LMP, today]; LMP is MOTHER_GA_DAYS before today.
        "visit_date": (today_ist() - timedelta(days=rng.randint(0, MOTHER_GA_DAYS))).isoformat(),
        "client_created_at": _iso_z(now - timedelta(minutes=rng.randint(0, 72 * 60))),
    }
    if rng.random() < 0.8:
        fields["weight_kg"] = round(rng.uniform(25, 150), 2)
        fields["weight_source"] = rng.choice(["manual", "ble", "simulated"])
        if fields["weight_source"] == "ble" and rng.random() < 0.7:
            fields["ble_raw_hex"] = "".join(f"{rng.randrange(256):02X}" for _ in range(rng.randint(3, 13)))
    if rng.random() < 0.7:
        fields["hb_gdl"] = round(rng.uniform(3.0, 20.0), 1)
        fields["hb_source"] = rng.choice(["manual", "device"])
    if rng.random() < 0.5:
        dia = rng.randint(30, 159)
        fields["bp_diastolic"] = dia
        fields["bp_systolic"] = rng.randint(max(dia + 1, 60), 260)
        fields["bp_source"] = rng.choice(["manual", "ble"])
    if rng.random() < 0.5:
        fields["ifa_tablets"] = rng.randint(0, 180)
    if rng.random() < 0.3:
        fields["calcium_tablets"] = rng.randint(0, 180)
    if rng.random() < 0.4:
        fields["thr_received"] = rng.random() < 0.5
    if rng.random() < 0.4:
        fields["notes"] = "note " + "x" * rng.randint(0, 100)
    return fields


def _task_fields(rng: random.Random) -> Dict[str, Any]:
    fields: Dict[str, Any] = {
        "done_at": _iso_z(utcnow() - timedelta(minutes=rng.randint(0, 48 * 60))),
    }
    if rng.random() < 0.6:
        fields["done_note"] = "done " + "y" * rng.randint(0, 80)
    return fields


def gen_scenario(rng: random.Random) -> Dict[str, Any]:
    """k pushes of one visit change and one task completion.

    ``batched``: all k copies go into a single envelope (then nothing can happen
    between pushes); otherwise one envelope per attempt, with the mother possibly
    delivered after attempt ``deliver_after`` (1-based, < k).
    Repeat payloads are either identical or mutated (fresh schema-valid fields, an
    uppercased id, a different device id).
    """
    k = rng.randint(1, 5)
    batched = k > 1 and rng.random() < 0.25
    deliver_after: Optional[int] = None
    if not batched and k > 1 and rng.random() < 0.6:
        deliver_after = rng.randint(1, k - 1)
    attempts = []
    for i in range(k):
        mutate = i > 0 and rng.random() < 0.7
        attempts.append(
            {
                "visit": _visit_fields(rng) if (i == 0 or mutate) else None,  # None = same as first
                "task": _task_fields(rng) if (i == 0 or mutate) else None,
                "upper_ids": mutate and rng.random() < 0.4,
                "device_id": _rng_uuid(rng),
            }
        )
    return {
        "visit_id": _rng_uuid(rng),
        "task_id": _rng_uuid(rng),
        "k": k,
        "batched": batched,
        "deliver_after": deliver_after,
        "attempts": attempts,
    }


# --------------------------------------------------------------------------- helpers


def _make_task(task_id: str, mother: Mother, issuer_id: str, now: datetime) -> None:
    with db.SessionLocal() as s:
        seq = db.begin_write(s)
        s.add(
            Task(
                id=task_id,
                mother_id=mother.id,
                alert_id=None,
                issued_by_id=issuer_id,
                asha_id=mother.asha_id,
                action_type="HOME_VISIT_48H",
                instructions=None,
                due_date=today_ist() + timedelta(days=2),
                status="open",
                created_at=now,
                change_seq=seq,
            )
        )
        s.commit()


def _deliver(mother_id: str) -> None:
    with db.SessionLocal() as s:
        seq = db.begin_write(s)
        mother = s.get(Mother, mother_id)
        mother.status = "delivered"
        mother.change_seq = seq
        s.commit()


def _changes(scenario: Dict[str, Any], i: int, mother_id: str) -> List[Dict[str, Any]]:
    first = scenario["attempts"][0]
    attempt = scenario["attempts"][i]
    visit_body = dict(attempt["visit"] or first["visit"])
    task_body = dict(attempt["task"] or first["task"])
    visit_id, task_id = scenario["visit_id"], scenario["task_id"]
    if attempt["upper_ids"]:
        visit_id, task_id = visit_id.upper(), task_id.upper()
    visit_body.update(id=visit_id, mother_id=mother_id)
    task_body.update(id=task_id)
    return [
        {"entity": "visit", "op": "create", "data": visit_body},
        {"entity": "task", "op": "complete", "data": task_body},
    ]


def _snapshot(s, scenario: Dict[str, Any], mother_id: str) -> Dict[str, Any]:
    visits = s.execute(select(Visit).where(Visit.mother_id == mother_id)).scalars().all()
    task = s.get(Task, scenario["task_id"])
    return {
        "visits": [
            {c: getattr(v, c) for c in (*VISIT_COLUMNS, "id", "recorded_by_id", "device_id", "received_at", "change_seq")}
            for v in visits
        ],
        "task": {c: getattr(task, c) for c in ("status", "done_at", "done_note", "change_seq")},
        "task_done_sms": s.execute(
            select(func.count())
            .select_from(NotificationOutbox)
            .where(
                NotificationOutbox.kind == "task_done",
                NotificationOutbox.related_task_id == scenario["task_id"],
            )
        ).scalar_one(),
        "alerts": s.execute(
            select(func.count()).select_from(Alert).where(Alert.mother_id == mother_id)
        ).scalar_one(),
    }


# --------------------------------------------------------------------------- property


@for_all(gen_scenario, runs=40)
def test_push_idempotency(scenario, world, factory) -> None:
    """Feature: maatriva-mvp, Property 16: Push idempotency"""
    fac = world.a
    mother = factory.mother(fac.villages[0], fac.asha, ga=MOTHER_GA_DAYS)
    base_now = utcnow()
    _make_task(scenario["task_id"], mother, fac.doctor.id, base_now)
    with db.SessionLocal() as s:
        user = load_current_user(s, fac.asha.id)
    assert user is not None and mother.village_id in user.village_ids

    k = scenario["k"]
    first = scenario["attempts"][0]
    expected_visit = VisitIn.model_validate(
        {**first["visit"], "id": scenario["visit_id"], "mother_id": mother.id},
        context={"now": base_now},
    )
    expected_task = TaskCompleteIn.model_validate(
        {**first["task"], "id": scenario["task_id"]}, context={"now": base_now}
    )

    # Build the push calls: one envelope per attempt, or all attempts in one envelope.
    if scenario["batched"]:
        calls = [
            (
                first["device_id"],
                [c for i in range(k) for c in _changes(scenario, i, mother.id)],
                0,
            )
        ]
    else:
        calls = [
            (scenario["attempts"][i]["device_id"], _changes(scenario, i, mother.id), i)
            for i in range(k)
        ]

    statuses: Dict[str, List[str]] = {"visit": [], "task": []}
    after_first: Optional[Dict[str, Any]] = None
    for device_id, changes, i in calls:
        now = base_now + timedelta(seconds=i)
        envelope = PushIn.model_validate({"device_id": device_id, "changes": changes})
        outcome = sync_service.push(db.SessionLocal, user, envelope, now)

        assert len(outcome.results) == len(changes)
        for change, result in zip(changes, outcome.results):
            assert result.entity == change["entity"]
            assert result.id == change["data"]["id"].lower()
            assert result.error is None, result.error
            statuses[result.entity].append(result.status)
        # duplicates still re-run triage for the mother (Req 7.9)
        assert outcome.affected_mother_ids == [mother.id]

        with db.SessionLocal() as s:
            snap = _snapshot(s, scenario, mother.id)
        if after_first is None:
            after_first = snap
        else:
            # Repeats change nothing: same row, same completion, no new SMS/alerts.
            assert snap == after_first
        if scenario["deliver_after"] == i + 1:
            _deliver(mother.id)

    expected_statuses = ["applied"] + ["duplicate"] * (k - 1)
    assert statuses["visit"] == expected_statuses
    assert statuses["task"] == expected_statuses

    assert after_first is not None
    # Exactly one stored visit, equal to the first push.
    assert len(after_first["visits"]) == 1
    row = after_first["visits"][0]
    assert row["id"] == scenario["visit_id"]
    for column in VISIT_COLUMNS:
        assert row[column] == getattr(expected_visit, column), column
    assert row["recorded_by_id"] == fac.asha.id
    assert row["device_id"] == str(uuid.UUID(first["device_id"]))
    assert row["received_at"] == base_now

    # Exactly one completion, equal to the first push.
    task = after_first["task"]
    assert task["status"] == "done"
    assert task["done_at"] == expected_task.done_at
    assert task["done_note"] == expected_task.done_note
    # At most one task_done SMS, written by the first push only (the writer itself
    # lands with the alert-router wiring; repeats must never add another).
    assert after_first["task_done_sms"] <= 1

    # Final state still has exactly one visit and one completion.
    with db.SessionLocal() as s:
        final = _snapshot(s, scenario, mother.id)
        assert final == after_first
        if scenario["deliver_after"] is not None:
            assert s.get(Mother, mother.id).status == "delivered"
