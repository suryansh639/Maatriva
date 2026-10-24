"""Persistence core: engine/session factory, the global write lock and Change_Seq.

Callers outside request handlers (seed, triage_all, demo helpers, lifespan, tests)
MUST use ``from app import db`` and call ``db.SessionLocal()``, never
``from app.db import SessionLocal``: ``configure_engine`` rebinds the module
attributes, and a name imported by value would keep the stale factory.
"""
from __future__ import annotations

import logging
import uuid
from typing import Iterator, Optional

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.pool import StaticPool

log = logging.getLogger(__name__)


class Base(DeclarativeBase):
    """Declarative base for every ORM model in ``app.models``."""


engine: Optional[Engine] = None
SessionLocal: Optional[sessionmaker] = None


def _is_sqlite(url: str) -> bool:
    return url.startswith("sqlite")


def _is_sqlite_memory(url: str) -> bool:
    return url in ("sqlite://", "sqlite:///:memory:") or "mode=memory" in url


def _sqlite_on_connect(dbapi_connection, _connection_record) -> None:
    cursor = dbapi_connection.cursor()
    try:
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=15000")
    finally:
        cursor.close()


def configure_engine(url: str) -> Engine:
    """Create the engine for ``url`` and rebind the module-level ``engine`` and
    ``SessionLocal``. Any previously configured engine is disposed (releases
    SQLite file handles, which matters for temp databases on Windows)."""
    global engine, SessionLocal

    old = engine
    kwargs: dict = {}
    if _is_sqlite(url):
        kwargs["connect_args"] = {"check_same_thread": False, "timeout": 15}
        if _is_sqlite_memory(url):
            # One shared connection, otherwise every pool checkout sees a new empty DB.
            kwargs["poolclass"] = StaticPool

    new_engine = create_engine(url, **kwargs)
    if _is_sqlite(url):
        event.listen(new_engine, "connect", _sqlite_on_connect)

    engine = new_engine
    SessionLocal = sessionmaker(bind=new_engine, autoflush=True, expire_on_commit=False)

    if old is not None and old is not new_engine:
        old.dispose()
    return new_engine


def _ensure_configured() -> None:
    """Configure from settings on first use when nobody called ``configure_engine``."""
    if engine is None or SessionLocal is None:
        from app.config import get_settings  # lazy: keeps db importable on its own

        configure_engine(get_settings().database_url)


def begin_write(session: Session) -> int:
    """MUST be the first statement of every writing transaction (push change,
    apply_triage, task create, alert ack, birth outcome, digest send, demo
    endpoints, seed).

    Increments the single SyncCounter row, which takes the global write lock
    (SQLite RESERVED lock / PostgreSQL row lock) until commit or rollback, and
    returns the new value: this transaction's Change_Seq. Every Mother, Visit
    or Task row written in the transaction must carry it.

    No ORM object may be ``add()``-ed before this call, otherwise autoflush
    would emit the INSERT before the lock is taken.
    """
    session.execute(text("UPDATE sync_counter SET value = value + 1 WHERE id = 1"))
    return int(session.execute(text("SELECT value FROM sync_counter WHERE id = 1")).scalar_one())


def rotate_epoch(session: Session) -> str:
    """Set a new uuid4 Sync_Epoch inside the current write transaction (call after
    ``begin_write``). Forces every device's next pull to be a full snapshot with
    ``reset: true``. Returns the new epoch."""
    new_epoch = str(uuid.uuid4())
    session.execute(text("UPDATE sync_counter SET epoch = :e WHERE id = 1"), {"e": new_epoch})
    return new_epoch


def init_db() -> None:
    """``create_all()`` for every model, then insert ``SyncCounter(id=1, value=0,
    epoch=uuid4())`` when the row is missing."""
    _ensure_configured()
    from app import models  # lazy: registers every table on Base.metadata

    Base.metadata.create_all(bind=engine)
    with SessionLocal() as session:
        if session.get(models.SyncCounter, 1) is None:
            session.add(models.SyncCounter(id=1, value=0, epoch=str(uuid.uuid4())))
            session.commit()


def get_db() -> Iterator[Session]:
    """FastAPI dependency: one session per request, always closed. Reads the
    module attribute at call time so ``configure_engine`` rebinding applies."""
    _ensure_configured()
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
