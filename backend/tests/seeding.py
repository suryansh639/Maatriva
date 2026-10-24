"""Seeded-database helpers for the seed and demo tests.

Seeding takes a few seconds, so each test module seeds one template SQLite file
(module-scoped) and every test works on its own copy of that file: tests stay
isolated even when they mutate state, without paying for a reseed each time.
"""
from __future__ import annotations

import shutil
from datetime import date
from pathlib import Path
from typing import Dict, Tuple

from sqlalchemy import select

from app import db, seed
from app.models import User


def _url(path: Path) -> str:
    return f"sqlite:///{path.as_posix()}"


def _release() -> None:
    if db.engine is not None:
        db.engine.dispose()
    db.engine = None
    db.SessionLocal = None


def build_template(directory: Path, seed_day: date) -> Tuple[Path, seed.SeedReport]:
    """Seed a fresh database file in ``directory`` for ``seed_day``.

    The engine is disposed afterwards (checkpoints the WAL into the main file
    and releases Windows file handles), so the file can be copied as is.
    """
    path = directory / "template.db"
    db.configure_engine(_url(path))
    try:
        db.init_db()
        report = seed.seed(db.SessionLocal, seed_day)
    finally:
        _release()
    return path, report


def open_copy(template: Path, directory: Path):
    """Copy the template into ``directory`` and bind ``db`` to the copy."""
    target = directory / "seeded.db"
    shutil.copyfile(template, target)
    return db.configure_engine(_url(target))


def close_copy() -> None:
    _release()


def users_by_name() -> Dict[str, User]:
    """Every seeded user, keyed by username (detached, attributes loaded)."""
    with db.SessionLocal() as s:
        users = s.execute(select(User)).scalars().all()
        return {u.username: u for u in users}
