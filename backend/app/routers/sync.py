"""Sync routes for the field app (Requirements 7.1, 7.2, 7.10, 7.12).

- ``POST /api/sync/push`` (role ``asha``): validates the envelope, then hands it
  to ``sync_service.push``, which applies each change in its own transaction and
  returns index-aligned results.
- ``GET /api/sync/pull?since=<cursor>`` (role ``asha``): ``sync_service.pull``
  reads the SyncCounter first and returns the in-scope rows with
  ``lower < change_seq <= upper`` plus all villages, ``server_time`` and the
  cursor ``"<epoch>:<upper>"`` (Req 12).

Error mapping:
- Invalid envelope → FastAPI's default 422 body. ``push_validation_exception_handler``
  (registered in ``main.py``) adds a WARNING with the user id and change count.
- ``PushDbError`` → 503 ``DB_BUSY``, logged at ERROR with a stack trace.

Logs carry user ids, entity names, record ids and codes only; never names,
phones or tokens (Req 7.12, 46.4).
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, List, Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app import db, sync_service, triage_service
from app import events as events_mod
from app.deps import CurrentUser, get_current_user, require_roles
from app.errors import DomainError
from app.schemas import ChangeResult, PullOut, PushIn, PushOut
from app.security import AuthError, decode_token
from app.sync_service import Event, InvalidCursor, PushDbError
from app.timeutil import iso_z, utcnow

log = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/sync",
    tags=["sync"],
    dependencies=[Depends(get_current_user)],
)

PUSH_PATH = "/api/sync/push"

DB_BUSY = "DB_BUSY"
DB_BUSY_MESSAGE = "Database busy, please retry"

_MAX_LOGGED_ENTITY = 40  # client-supplied text: keep log lines bounded


# --------------------------------------------------------------------------- helpers


def _log_rejections(user: CurrentUser, results: List[ChangeResult]) -> None:
    """One WARNING per rejected change: user id, entity, record id and code only."""
    for result in results:
        if result.status != "rejected" or result.error is None:
            continue
        log.warning(
            "push rejected: user %s entity %r id %s code %s",
            user.id,
            result.entity[:_MAX_LOGGED_ENTITY],
            result.id,
            result.error.code,
        )


def _finish_push(
    user: CurrentUser,
    affected_mother_ids: List[str],
    events: List[Event],
    now: datetime,
) -> None:
    """Post-push work, run after every change's own commit.

    Called on success and (best-effort) before the 503 on ``PushDbError``.

    - Runs ``triage_service.apply_triage`` once per id in ``affected_mother_ids``
      in a fresh ``db.SessionLocal()`` session (read at call time). A failure is
      logged at ERROR with the mother id and never fails the request (Req 7.9,
      7.10, 7.11).
    - Then publishes ``events`` (their changes are already committed) followed by
      the triage events (each triage run commits before returning), so nothing
      is published before its commit (Req 18.6).
    """
    triage_events: List[Event] = []
    if affected_mother_ids:
        db._ensure_configured()  # noqa: SLF001 - same lazy config as get_db
        with db.SessionLocal() as session:
            for mother_id in affected_mother_ids:
                try:
                    outcome = triage_service.apply_triage(session, mother_id, now)
                except Exception:
                    log.exception(
                        "post-push triage failed: user %s mother %s", user.id, mother_id
                    )
                    try:
                        session.rollback()
                    except Exception:  # keep going with the next mother
                        log.exception("rollback failed after triage error: mother %s", mother_id)
                    continue
                triage_events.extend(outcome.events)

    for facility_id, name, payload in list(events) + triage_events:
        try:
            events_mod.broker.publish(facility_id, name, payload)
        except Exception:  # publishing is best effort; the data is committed
            log.exception("publish failed: event %s facility %s", name, facility_id)


# --------------------------------------------------------------------------- routes


@router.post("/push", response_model=PushOut)
def push(
    envelope: PushIn,
    user: CurrentUser = require_roles("asha"),
) -> PushOut:
    now = utcnow()
    try:
        outcome = sync_service.push(None, user, envelope, now)
    except PushDbError as exc:
        log.error(
            "push aborted by database error: user %s at change %d of %d",
            user.id,
            exc.failed_index,
            len(envelope.changes),
            exc_info=True,
        )
        _log_rejections(user, exc.results)
        try:
            _finish_push(user, exc.affected_mother_ids, exc.events, now)
        except Exception:  # best effort only; the 503 still goes out
            log.exception("post-push work failed after database error: user %s", user.id)
        raise DomainError(503, DB_BUSY, DB_BUSY_MESSAGE) from None

    _log_rejections(user, outcome.results)
    _finish_push(user, outcome.affected_mother_ids, outcome.events, now)
    return PushOut(server_time=iso_z(now), results=outcome.results)


@router.get("/pull", response_model=PullOut)
def pull(
    since: Optional[str] = Query(None),
    user: CurrentUser = require_roles("asha"),
    session: Session = Depends(db.get_db),
) -> PullOut:
    """Changes in the caller's scope since ``since`` (Req 12). Malformed cursor →
    400 ``INVALID_CURSOR``; foreign epoch or seq past the counter → full snapshot
    with ``reset: true``. Both logged at INFO with the user id only."""
    try:
        out = sync_service.pull(session, user, since, utcnow())
    except InvalidCursor:
        log.info("pull rejected: user %s code %s", user.id, sync_service.INVALID_CURSOR)
        raise
    if out.reset:
        log.info("pull reset: user %s (foreign epoch or cursor ahead of counter)", user.id)
    return out


# --------------------------------------------------------------------------- 422 logging


def _user_id_from_request(request: Request) -> str:
    """Best-effort user id from the bearer token (claims only, no DB); 'unknown'
    when the header is missing or the token does not verify."""
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return "unknown"
    try:
        return str(decode_token(token.strip())["sub"])
    except AuthError:
        return "unknown"
    except Exception:  # never fail the 422 because of logging
        return "unknown"


def _change_count(body: Any) -> Optional[int]:
    if isinstance(body, dict) and isinstance(body.get("changes"), list):
        return len(body["changes"])
    return None


async def push_validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """Keeps FastAPI's default 422 body; on the push path it first logs a WARNING
    with the user id and the change count when it can be determined (Req 7.2)."""
    if request.url.path == PUSH_PATH:
        count = _change_count(getattr(exc, "body", None))
        log.warning(
            "push envelope invalid: user %s changes %s errors %d",
            _user_id_from_request(request),
            count if count is not None else "unknown",
            len(exc.errors()),
        )
    return await request_validation_exception_handler(request, exc)


__all__ = [
    "router",
    "PUSH_PATH",
    "DB_BUSY",
    "push_validation_exception_handler",
]
