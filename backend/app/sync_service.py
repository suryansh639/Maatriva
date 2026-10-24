"""Sync push: per-change validation, apply and commit (Requirements 7–11).

``push(session_factory, user, envelope, now)`` processes ``envelope.changes`` in
array order. For each change:

1. Look up the handler for ``(entity, op)``; unknown pairs are rejected with
   ``UNKNOWN_ENTITY``.
2. Validate ``data`` with the handler's schema (``context={"now": now}``). This
   needs no database and runs *before* the write lock, so invalid data never
   takes it. Failures are rejected with ``VALIDATION_ERROR`` and
   ``first_error_message``.
3. Open a fresh session, call ``db.begin_write`` as the first statement (its
   value is the Change_Seq stamped on every row written), run the handler and
   commit. A rejected change is rolled back (handlers write nothing before
   deciding to reject).

``results[i]`` always matches ``changes[i]``: same ``entity``, and ``id`` is the
lowercase ``data.id`` when it is a UUID, else null (Req 7.4–7.6).

The returned ``affected_mother_ids`` (ordered, unique) are the mothers whose
change ended ``applied``, ``duplicate`` or ``stale``; the router runs triage once
per id after the loop (Req 7.9, wired in task 10.5). ``events`` are
``(facility_id, event, payload)`` tuples queued by handlers, to be published only
after their commit.

A database error (``DBAPIError``, which includes ``OperationalError``) rolls back
the current change and raises ``PushDbError`` carrying the results, affected
mother ids and events of the changes already committed (Req 7.10).

Nothing here logs names or phones; rejected-change logging is done by the router
with ids and codes only (Req 7.12).

``pull(session, user, since, now)`` (Req 12) reads the SyncCounter first, resolves
the cursor with the pure ``resolve_cursor`` and returns the rows of the caller's
scope with ``lower < change_seq <= upper``; see the pull section below.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Callable, Dict, List, Optional, Tuple, Type

from pydantic import BaseModel, ValidationError
from sqlalchemy import and_, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session, selectinload

from app import db
from app.deps import CurrentUser, mother_scope_filter
from app.errors import DomainError
from app.gestation import edd_naegele
from app.models import (
    Mother,
    MotherStatus,
    RiskFlag,
    RiskLevel,
    SyncCounter,
    Task,
    TaskStatus,
    Village,
    Visit,
)
from app.schemas import (
    ChangeResult,
    MotherIn,
    MotherOut,
    PullOut,
    PushIn,
    TaskCompleteIn,
    TaskOut,
    VillageOut,
    VisitIn,
    VisitOut,
    first_error_message,
    normalize_uuid_or_none,
)
from app.timeutil import ist_date, iso_z, to_utc_naive, utcnow

# --------------------------------------------------------------------------- codes

UNKNOWN_ENTITY = "UNKNOWN_ENTITY"
VALIDATION_ERROR = "VALIDATION_ERROR"
OUT_OF_SCOPE = "OUT_OF_SCOPE"
MOTHER_NOT_FOUND = "MOTHER_NOT_FOUND"
CONFLICT = "CONFLICT"
MOTHER_INACTIVE = "MOTHER_INACTIVE"
TASK_NOT_FOUND = "TASK_NOT_FOUND"
TASK_CANCELLED = "TASK_CANCELLED"

_MESSAGES = {
    UNKNOWN_ENTITY: "Unknown entity or operation",
    OUT_OF_SCOPE: "Record is outside your assigned villages",
    MOTHER_NOT_FOUND: "Mother not found",
    CONFLICT: "Visit id already exists for a different mother",
    MOTHER_INACTIVE: "Mother is no longer active (delivered)",
    TASK_NOT_FOUND: "Task not found",
    TASK_CANCELLED: "Task was cancelled",
}

# Client-owned Mother fields: overwritten by a newer upsert (Req 8.5).
MOTHER_CLIENT_FIELDS = (
    "full_name",
    "age",
    "guardian_name",
    "village_id",
    "phone",
    "lmp_date",
    "is_bpl",
    "height_cm",
    "first_weight_kg",
    "registered_at",
    "updated_at",
)

VISIT_DATE_MAX_AHEAD = timedelta(days=1)

Event = Tuple[str, str, Dict[str, Any]]  # (facility_id, event name, payload)

# --------------------------------------------------------------------------- results


@dataclass
class ChangeOutcome:
    """What one handler produced. ``mother_id`` is the mother to re-triage (None
    for rejections); ``events`` are published after this change's commit."""

    result: ChangeResult
    mother_id: Optional[str] = None
    events: List[Event] = field(default_factory=list)


@dataclass
class PushOutcome:
    results: List[ChangeResult]
    affected_mother_ids: List[str]
    events: List[Event]


class PushDbError(Exception):
    """A database error stopped the push. Carries everything committed so far so
    the router can run best-effort triage and still publish committed events
    before returning 503 ``DB_BUSY``."""

    def __init__(
        self,
        results: List[ChangeResult],
        affected_mother_ids: List[str],
        events: List[Event],
        failed_index: int,
    ) -> None:
        super().__init__(f"database error at change {failed_index}")
        self.results = results
        self.affected_mother_ids = affected_mother_ids
        self.events = events
        self.failed_index = failed_index


def _rejected(entity: str, rid: Optional[str], code: str, message: Optional[str] = None) -> ChangeOutcome:
    return ChangeOutcome(ChangeResult.rejected(entity, rid, code, message or _MESSAGES[code]))


def _ok(entity: str, rid: Optional[str], status: str, mother_id: str) -> ChangeOutcome:
    return ChangeOutcome(ChangeResult.ok(entity, rid, status), mother_id=mother_id)  # type: ignore[arg-type]


# --------------------------------------------------------------------------- handlers
#
# Each handler runs inside the change's transaction, *after* ``db.begin_write``,
# and must stamp ``change_seq = seq`` on every Mother / Visit / Task it writes.


def apply_mother_upsert(
    s: Session, user: CurrentUser, device_id: str, m: MotherIn, seq: int, now: datetime
) -> ChangeOutcome:
    entity = "mother"
    # 1. Incoming village must be one of the caller's (facility-filtered) villages.
    if m.village_id not in user.village_ids:
        return _rejected(entity, m.id, OUT_OF_SCOPE)
    village = s.get(Village, m.village_id)
    if village is None:
        return _rejected(entity, m.id, OUT_OF_SCOPE)

    client_values = {name: getattr(m, name) for name in MOTHER_CLIENT_FIELDS}
    stored = s.get(Mother, m.id)

    # 2. Insert.
    if stored is None:
        s.add(
            Mother(
                id=m.id,
                **client_values,
                facility_id=village.facility_id,
                asha_id=user.id,
                edd_date=edd_naegele(m.lmp_date),
                status=MotherStatus.active.value,
                risk_level=RiskLevel.GREEN.value,
                change_seq=seq,
            )
        )
        return _ok(entity, m.id, "applied", m.id)

    # 3. The stored row must be in scope too (no hijacking another village's mother).
    if stored.village_id not in user.village_ids:
        return _rejected(entity, m.id, OUT_OF_SCOPE)

    # 4. Last-write-wins on the client clock; asha_id/status/risk stay server-owned.
    if m.updated_at > stored.updated_at:
        for name, value in client_values.items():
            setattr(stored, name, value)
        stored.facility_id = village.facility_id
        stored.edd_date = edd_naegele(m.lmp_date)
        stored.change_seq = seq
        return _ok(entity, m.id, "applied", m.id)

    # 5. Equal or older: no write.
    return _ok(entity, m.id, "stale", m.id)


def apply_visit_create(
    s: Session, user: CurrentUser, device_id: str, v: VisitIn, seq: int, now: datetime
) -> ChangeOutcome:
    entity = "visit"
    # 1. Mother exists.
    mother = s.get(Mother, v.mother_id)
    if mother is None:
        return _rejected(entity, v.id, MOTHER_NOT_FOUND)
    # 2. Scope.
    if mother.village_id not in user.village_ids:
        return _rejected(entity, v.id, OUT_OF_SCOPE)
    # 3./4. Duplicate (same mother) or conflict (other mother). Runs before the
    # delivered check so a retry after delivery still reports duplicate (Req 9.3).
    existing = s.get(Visit, v.id)
    if existing is not None:
        if existing.mother_id == mother.id:
            # Never update: synced visits are immutable (Req 9.7).
            return _ok(entity, v.id, "duplicate", mother.id)
        return _rejected(entity, v.id, CONFLICT)
    # 5. Delivered mother takes no new visits.
    if mother.status == MotherStatus.delivered.value:
        return _rejected(entity, v.id, MOTHER_INACTIVE)
    # 6. Date range needs the mother's LMP (Req 11.9).
    if v.visit_date < mother.lmp_date:
        return _rejected(
            entity, v.id, VALIDATION_ERROR, "visit_date: must be on or after the LMP date"
        )
    if v.visit_date > ist_date(now) + VISIT_DATE_MAX_AHEAD:
        return _rejected(
            entity,
            v.id,
            VALIDATION_ERROR,
            "visit_date: must not be more than 1 day after today (IST)",
        )
    # 7. Insert.
    s.add(
        Visit(
            **v.model_dump(),
            recorded_by_id=user.id,
            device_id=device_id,
            received_at=now,
            change_seq=seq,
        )
    )
    return _ok(entity, v.id, "applied", mother.id)


def on_task_completed(
    s: Session, user: CurrentUser, task: Task, now: datetime
) -> List[Event]:
    """Hook run inside the completing transaction, after the task is marked done
    and before commit. Returns events to publish after commit.

    Task 10.5 extends this: ``task_done`` SMS to the issuing doctor,
    ``alert_router.on_task_done`` and the ``task.done`` (+ ``alert.updated``)
    events. Until then it does nothing."""
    return []


def apply_task_complete(
    s: Session, user: CurrentUser, device_id: str, t: TaskCompleteIn, seq: int, now: datetime
) -> ChangeOutcome:
    entity = "task"
    task = s.get(Task, t.id)
    # Identical response for absent and not-yours (no existence leak).
    if task is None or task.asha_id != user.id:
        return _rejected(entity, t.id, TASK_NOT_FOUND)
    if task.status == TaskStatus.done.value:
        return _ok(entity, t.id, "duplicate", task.mother_id)
    if task.status == TaskStatus.cancelled.value:
        return _rejected(entity, t.id, TASK_CANCELLED)
    task.status = TaskStatus.done.value
    task.done_at = t.done_at
    task.done_note = t.done_note
    task.change_seq = seq
    s.flush()
    outcome = _ok(entity, t.id, "applied", task.mother_id)
    outcome.events.extend(on_task_completed(s, user, task, now))
    return outcome


@dataclass(frozen=True)
class Handler:
    schema: Type[BaseModel]
    apply: Callable[[Session, CurrentUser, str, Any, int, datetime], ChangeOutcome]


HANDLERS: Dict[Tuple[str, str], Handler] = {
    ("mother", "upsert"): Handler(MotherIn, apply_mother_upsert),
    ("visit", "create"): Handler(VisitIn, apply_visit_create),
    ("task", "complete"): Handler(TaskCompleteIn, apply_task_complete),
}

# --------------------------------------------------------------------------- push


def push(
    session_factory: Optional[Callable[[], Session]],
    user: CurrentUser,
    envelope: PushIn,
    now: Optional[datetime] = None,
) -> PushOutcome:
    """Apply ``envelope.changes`` one transaction each, in array order.

    ``session_factory`` defaults to ``db.SessionLocal`` read at call time (so
    ``configure_engine`` rebinding applies). ``now`` is naive UTC server time,
    defaulting to ``utcnow()``; it drives validation, ``received_at`` and the
    visit date range.
    """
    factory = session_factory or db.SessionLocal
    if factory is None:
        db._ensure_configured()  # noqa: SLF001 - same lazy config as get_db
        factory = db.SessionLocal
    now = to_utc_naive(now) if now is not None else utcnow()
    device_id = str(envelope.device_id)

    results: List[ChangeResult] = []
    affected: Dict[str, None] = {}  # ordered set
    events: List[Event] = []

    for index, change in enumerate(envelope.changes):
        rid = normalize_uuid_or_none(change.data.get("id"))
        handler = HANDLERS.get((change.entity, change.op))
        if handler is None:
            results.append(_rejected(change.entity, rid, UNKNOWN_ENTITY).result)
            continue
        try:
            model = handler.schema.model_validate(change.data, context={"now": now})
        except ValidationError as exc:
            results.append(
                _rejected(change.entity, rid, VALIDATION_ERROR, first_error_message(exc)).result
            )
            continue

        with factory() as s:
            try:
                seq = db.begin_write(s)
                outcome = handler.apply(s, user, device_id, model, seq, now)
                if outcome.result.status == "rejected":
                    s.rollback()  # nothing to keep; releases the lock without a write
                else:
                    s.commit()
            except DBAPIError as exc:
                s.rollback()
                raise PushDbError(results, list(affected), events, index) from exc

        # Handlers build results from the validated id; keep the wire entity name.
        result = outcome.result
        if result.entity != change.entity or result.id != rid:
            result = result.model_copy(update={"entity": change.entity, "id": rid})
        results.append(result)
        if result.status != "rejected" and outcome.mother_id is not None:
            affected[outcome.mother_id] = None
        events.extend(outcome.events)

    return PushOutcome(results=results, affected_mother_ids=list(affected), events=events)


# --------------------------------------------------------------------------- pull
#
# Pull (Req 12). The SyncCounter is read first; its value is ``upper`` and every
# selected row satisfies ``lower < change_seq <= upper``. Writers commit in
# ``begin_write`` lock order, so a row committed after ``upper`` was read carries
# a larger seq and is picked up by the next pull: nothing is lost even without a
# snapshot transaction. Pulls carry no deletes; paths that delete syncable rows
# rotate the epoch instead, which forces ``reset: true``.

INVALID_CURSOR = "INVALID_CURSOR"
INVALID_CURSOR_MESSAGE = "Unrecognised sync cursor"

# ``<lowercase uuid epoch>:<1-18 ASCII digits>``. ``[0-9]`` rather than ``\d`` so
# non-ASCII digits are rejected.
CURSOR_RE = re.compile(
    r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9]{1,18})"
)

_FLAG_SEVERITY_ORDER = {"RED": 0, "AMBER": 1, "INFO": 2}


class InvalidCursor(DomainError):
    """400 ``INVALID_CURSOR``: ``since`` is not empty, ``"0"`` or ``<epoch>:<seq>``."""

    def __init__(self) -> None:
        super().__init__(400, INVALID_CURSOR, INVALID_CURSOR_MESSAGE)


def resolve_cursor(since: Optional[str], epoch: str, upper: int) -> Tuple[int, bool]:
    """Pure cursor resolution. Returns ``(lower_seq, reset)``.

    - missing, ``""`` or ``"0"`` → ``(0, False)`` (full snapshot, Req 12.2)
    - not matching ``CURSOR_RE`` → raises ``InvalidCursor`` (Req 12.3)
    - foreign epoch, or seq beyond the current counter → ``(0, True)`` (Req 12.4)
    - otherwise → ``(seq, False)``
    """
    if since is None or since in ("", "0"):
        return 0, False
    match = CURSOR_RE.fullmatch(since)
    if match is None:
        raise InvalidCursor()
    cursor_epoch, seq = match.group(1), int(match.group(2))
    if cursor_epoch != epoch or seq > upper:
        return 0, True
    return seq, False


def format_cursor(epoch: str, upper: int) -> str:
    return f"{epoch}:{upper}"


def read_counter(s: Session) -> Tuple[int, str]:
    """``(value, epoch)`` of the SyncCounter row, read with a fresh query."""
    value, epoch = s.execute(
        select(SyncCounter.value, SyncCounter.epoch).where(SyncCounter.id == 1)
    ).one()
    return int(value), str(epoch)


def _active_flags(mother: Mother) -> List[RiskFlag]:
    active = [f for f in mother.flags if f.active]
    active.sort(key=lambda f: (_FLAG_SEVERITY_ORDER.get(f.severity, 9), f.code))
    return active


def pull(
    s: Session,
    user: CurrentUser,
    since: Optional[str],
    now: Optional[datetime] = None,
) -> PullOut:
    """Build the pull response for an ASHA (Req 12.2–12.10).

    Read-only. ``now`` (naive UTC, default ``utcnow()``) gives ``server_time`` and
    the IST ``today`` used for ``is_overdue``. Raises ``InvalidCursor``.
    """
    now = to_utc_naive(now) if now is not None else utcnow()
    today = ist_date(now)

    # 1. Counter FIRST: upper bound and epoch (Req 12.5).
    upper, epoch = read_counter(s)
    # 2. Cursor.
    lower, reset = resolve_cursor(since, epoch, upper)

    in_scope = mother_scope_filter(user)
    village_ids = sorted(user.village_ids)

    def in_range(column):
        return and_(column > lower, column <= upper)

    # 3. Mothers in the caller's villages, with their flags (active ones serialized).
    mothers = (
        s.execute(
            select(Mother)
            .where(in_scope, in_range(Mother.change_seq))
            .options(selectinload(Mother.flags))
            .order_by(Mother.change_seq, Mother.id)
        )
        .scalars()
        .all()
    )

    # 4. Visits of ANY in-scope mother in the range, whether or not her own row
    #    changed (e.g. a GREEN visit from a co-ASHA sharing the village).
    in_scope_mother_ids = select(Mother.id).where(in_scope)
    visits = (
        s.execute(
            select(Visit)
            .where(Visit.mother_id.in_(in_scope_mother_ids), in_range(Visit.change_seq))
            .order_by(Visit.change_seq, Visit.id)
        )
        .scalars()
        .all()
    )

    # 5. Tasks assigned to the caller.
    tasks = (
        s.execute(
            select(Task)
            .where(Task.asha_id == user.id, in_range(Task.change_seq))
            .options(selectinload(Task.issued_by))
            .order_by(Task.change_seq, Task.id)
        )
        .scalars()
        .all()
    )

    # 6. All villages in scope, always (Req 12.6).
    villages = (
        s.execute(select(Village).where(Village.id.in_(village_ids)).order_by(Village.name, Village.id))
        .scalars()
        .all()
        if village_ids
        else []
    )

    return PullOut(
        cursor=format_cursor(epoch, upper),
        reset=reset,
        server_time=iso_z(now),
        villages=[VillageOut.model_validate(v) for v in villages],
        mothers=[MotherOut.from_model(m, _active_flags(m)) for m in mothers],
        visits=[VisitOut.model_validate(v) for v in visits],
        tasks=[TaskOut.from_model(t, today) for t in tasks],
    )


__all__ = [
    "UNKNOWN_ENTITY",
    "VALIDATION_ERROR",
    "OUT_OF_SCOPE",
    "MOTHER_NOT_FOUND",
    "CONFLICT",
    "MOTHER_INACTIVE",
    "TASK_NOT_FOUND",
    "TASK_CANCELLED",
    "MOTHER_CLIENT_FIELDS",
    "ChangeOutcome",
    "PushOutcome",
    "PushDbError",
    "Handler",
    "HANDLERS",
    "apply_mother_upsert",
    "apply_visit_create",
    "apply_task_complete",
    "on_task_completed",
    "push",
    "INVALID_CURSOR",
    "CURSOR_RE",
    "InvalidCursor",
    "resolve_cursor",
    "format_cursor",
    "read_counter",
    "pull",
]
