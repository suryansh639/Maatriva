"""FastAPI application factory (Requirements 5.10, 46.1–46.5).

``create_app()`` builds the app; ``app = create_app()`` is the uvicorn target
``app.main:app``. Tests use ``create_app()`` through a ``TestClient`` that is not
entered as a context manager, so the lifespan never runs there.

Error format:
- ``DomainError`` → ``{"detail": {"code", "message"}}`` with its status/headers.
- Request validation errors keep FastAPI's default 422 body.
- Anything unexpected → 500 ``{"detail": {"code": "INTERNAL", ...}}``, logged
  with a stack trace. Log lines reference method and path only (ids, never
  names, phones or tokens; Req 46.4).

Lifespan (Req 15.9–15.11): capture the event loop into the SSE broker, then
``init_db()``, run startup ``triage_all`` on a worker thread and publish its
events, then start the periodic triage task; on shutdown cancel and await it.

Unauthenticated routes: ``GET /api/health`` and ``POST /api/auth/login`` only.
Every other router must declare ``dependencies=[Depends(get_current_user)]``.
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app import db
from app.config import get_settings
from app.errors import DomainError, domain_error_handler

log = logging.getLogger("app.main")

LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"


def configure_logging() -> None:
    """stdlib logging at INFO with the fixed format (Req 46.3). Idempotent: adds
    one handler to the root logger only if it has none (pytest/uvicorn may
    already have installed theirs)."""
    root = logging.getLogger()
    if not root.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter(LOG_FORMAT))
        root.addHandler(handler)
    root.setLevel(logging.INFO)
    logging.getLogger("app").setLevel(logging.INFO)


async def run_triage_all_and_publish() -> int:
    """Run ``triage_all(utcnow())`` on a worker thread (each mother commits in its
    own transaction), then publish every returned event (Req 18.6: publishes
    happen only after the commits). Returns the number of events published."""
    from app import triage_service
    from app.events import broker
    from app.timeutil import utcnow

    outcomes = await asyncio.to_thread(triage_service.triage_all, utcnow())
    published = 0
    for outcome in outcomes:
        for facility_id, event_name, payload in outcome.events:
            broker.publish(facility_id, event_name, payload)
            published += 1
    return published


async def periodic_triage(interval_s: float) -> None:
    """Re-triage all active mothers every ``interval_s`` seconds (Req 15.9).
    Any exception is logged at ERROR and the schedule continues (Req 15.10);
    cancellation (shutdown) propagates."""
    while True:
        await asyncio.sleep(interval_s)
        try:
            n = await run_triage_all_and_publish()
            log.info("periodic triage done events=%d", n)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("periodic triage failed; will retry in %ss", interval_s)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    from app.events import broker

    broker.capture_loop()  # before anything can publish (Req 18.2)
    db.init_db()

    # Startup triage (Req 15.9). A failure must not block startup.
    try:
        n = await run_triage_all_and_publish()
        log.info("startup triage done events=%d", n)
    except Exception:
        log.exception("startup triage failed")

    interval_s = get_settings().triage_interval_s
    task: Optional[asyncio.Task] = None
    if interval_s > 0:
        task = asyncio.create_task(periodic_triage(interval_s), name="periodic-triage")
    else:
        log.warning("periodic triage disabled (MAATRIVA_TRIAGE_INTERVAL_S=%s)", interval_s)

    log.info("startup complete")
    try:
        yield
    finally:
        # Req 15.11: cancel and await the periodic task.
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                log.exception("periodic triage task ended with an error")
        broker.release_loop()
        log.info("shutdown")


async def internal_error_handler(request: Request, exc: Exception) -> JSONResponse:
    log.error(
        "unhandled %s on %s %s",
        type(exc).__name__,
        request.method,
        request.url.path,
        exc_info=(type(exc), exc, exc.__traceback__),
    )
    return JSONResponse(
        status_code=500,
        content={"detail": {"code": "INTERNAL", "message": "Internal error"}},
    )


def create_app() -> FastAPI:
    configure_logging()
    application = FastAPI(title="Maatriva API", version="0.1.0", lifespan=lifespan)

    application.add_exception_handler(DomainError, domain_error_handler)
    application.add_exception_handler(Exception, internal_error_handler)
    # RequestValidationError: FastAPI's default 422 body is kept; this wrapper only
    # adds a WARNING (user id, change count) for invalid push envelopes (Req 7.2).
    from app.routers.sync import push_validation_exception_handler

    application.add_exception_handler(RequestValidationError, push_validation_exception_handler)

    @application.get("/api/health", tags=["meta"])
    def health() -> dict:
        return {"status": "ok", "demo": get_settings().demo}

    # ---- Router registration (keep every include_router in this block) ----
    from app.routers import (
        alerts,
        auth,
        dashboard,
        demo,
        digest,
        mothers,
        notifications,
        outcomes,
        sync,
        tasks,
    )

    application.include_router(auth.router)
    application.include_router(sync.router)
    application.include_router(alerts.router)
    application.include_router(mothers.router)
    application.include_router(tasks.router)
    application.include_router(outcomes.router)
    application.include_router(dashboard.router)
    application.include_router(notifications.router)
    application.include_router(digest.router)
    application.include_router(demo.router)  # 404 unless MAATRIVA_DEMO=1
    # ------------------------------------------------------------------------

    return application


app = create_app()
