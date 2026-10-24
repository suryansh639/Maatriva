"""Dashboard census and triage queue (Requirements 20.1, 21.1–21.3; design §13).

Both routes are doctor and ANM only (ASHA and admin → 403) and cover the
caller's facility through ``deps.mother_scope_filter``.

- ``GET /api/dashboard/census``: ``CensusOut`` for the active (pregnant) mothers,
  "today" being the IST date.
- ``GET /api/dashboard/queue?village_id=&risk=``: ``QueueRowOut[]`` sorted RED →
  AMBER → GREEN, then ``risk_updated_at`` descending. ``risk`` must be RED, AMBER
  or GREEN and ``village_id`` a village of the caller's facility; anything else is
  FastAPI's default 422 body (Req 21.3, 46.1).
"""
from __future__ import annotations

from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, Query
from fastapi.exceptions import RequestValidationError
from sqlalchemy.orm import Session

from app import dashboard_service, db
from app.deps import CurrentUser, get_current_user, normalize_id, require_roles
from app.schemas import CensusOut, QueueRowOut
from app.timeutil import today_ist

router = APIRouter(
    prefix="/api/dashboard",
    tags=["dashboard"],
    dependencies=[Depends(get_current_user)],
)


@router.get("/census", response_model=CensusOut)
def census(
    user: CurrentUser = require_roles("doctor", "anm"),
    session: Session = Depends(db.get_db),
) -> CensusOut:
    return dashboard_service.load_census(session, user, today_ist())


def _invalid_village(value: str) -> RequestValidationError:
    return RequestValidationError(
        [
            {
                "type": "value_error",
                "loc": ("query", "village_id"),
                "msg": "Value error, village_id is not a village of your facility",
                "input": value,
            }
        ]
    )


@router.get("/queue", response_model=List[QueueRowOut])
def queue(
    village_id: Optional[str] = Query(None),
    risk: Optional[Literal["RED", "AMBER", "GREEN"]] = Query(None),
    user: CurrentUser = require_roles("doctor", "anm"),
    session: Session = Depends(db.get_db),
) -> List[QueueRowOut]:
    vid: Optional[str] = None
    if village_id is not None:
        vid = normalize_id(village_id)
        if vid is None or vid not in dashboard_service.facility_village_ids(session, user):
            raise _invalid_village(village_id)
    rows = dashboard_service.load_queue_rows(session, user, today_ist())
    return dashboard_service.sort_queue(rows, village_id=vid, risk=risk)


__all__ = ["router"]
