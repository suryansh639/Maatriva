"""Outcome metrics for the dashboard (Requirements 24.6, 24.7; design §13).

``GET /api/outcomes`` (doctor, ANM): the facility counts
``hb_improved_after_action``, ``mothers_with_action_and_followup_hb``,
``births_recorded``, ``lbw_count`` and ``live_births`` from
``outcome_service.metrics``, scoped to the caller's facility.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import db, outcome_service
from app.deps import CurrentUser, get_current_user, require_roles
from app.schemas import OutcomesOut

router = APIRouter(
    prefix="/api/outcomes",
    tags=["outcomes"],
    dependencies=[Depends(get_current_user)],
)


@router.get("", response_model=OutcomesOut)
def get_outcomes(
    user: CurrentUser = require_roles("doctor", "anm"),
    session: Session = Depends(db.get_db),
) -> OutcomesOut:
    return outcome_service.metrics(session, user)


__all__ = ["router"]
