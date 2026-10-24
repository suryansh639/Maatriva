"""Facility task list for the dashboard (Requirement 23.8; design §13).

``GET /api/tasks?status=open|done|overdue|all`` (doctor, ANM): the tasks of the
caller's facility (through ``deps.mother_scope_filter``), each with the derived
``is_overdue`` (open and ``due_date`` before the IST date today, Req 12.10).
``overdue`` keeps exactly those; ``open`` and ``done`` filter by status; ``all``
(default) returns every status, including ``cancelled``. Newest first.
"""
from __future__ import annotations

from typing import List, Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app import db
from app.deps import CurrentUser, get_current_user, mother_scope_filter, require_roles
from app.models import Mother, Task, TaskStatus
from app.schemas import TaskListOut
from app.timeutil import today_ist

router = APIRouter(
    prefix="/api/tasks",
    tags=["tasks"],
    dependencies=[Depends(get_current_user)],
)


@router.get("", response_model=List[TaskListOut])
def list_tasks(
    status: Literal["open", "done", "overdue", "all"] = Query("all"),
    user: CurrentUser = require_roles("doctor", "anm"),
    session: Session = Depends(db.get_db),
) -> List[TaskListOut]:
    today = today_ist()
    stmt = (
        select(Task)
        .join(Mother, Mother.id == Task.mother_id)
        .where(mother_scope_filter(user))
        .options(
            selectinload(Task.mother).selectinload(Mother.village),
            selectinload(Task.issued_by),
        )
    )
    if status in ("open", "overdue"):
        stmt = stmt.where(Task.status == TaskStatus.open.value)
    elif status == "done":
        stmt = stmt.where(Task.status == TaskStatus.done.value)
    if status == "overdue":
        stmt = stmt.where(Task.due_date < today)
    stmt = stmt.order_by(Task.created_at.desc(), Task.id.desc())
    tasks = session.execute(stmt).scalars().all()
    return [TaskListOut.from_model(t, today) for t in tasks]


__all__ = ["router"]
