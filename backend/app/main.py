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

Unauthenticated routes: ``GET /api/health`` and ``POST /api/auth/login`` only.
Every other router must declare ``dependencies=[Depends(get_current_user)]``.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Request
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


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    db.init_db()
    log.info("startup complete")
    yield
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
    # RequestValidationError: FastAPI's default 422 handler is kept on purpose.

    @application.get("/api/health", tags=["meta"])
    def health() -> dict:
        return {"status": "ok", "demo": get_settings().demo}

    # ---- Router registration (keep every include_router in this block) ----
    from app.routers import auth

    application.include_router(auth.router)
    # ------------------------------------------------------------------------

    return application


app = create_app()
