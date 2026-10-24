"""Shared pytest fixtures (Requirement 44.1).

- Environment: a fixed ``MAATRIVA_JWT_SECRET`` (tests never write
  ``backend/.secrets``) and an in-memory ``DATABASE_URL`` fallback (tests never
  touch ``backend/maatriva.db``). Set before any app module reads settings.
- ``db_engine``: an isolated temp SQLite file per test via ``db.configure_engine``
  and ``db.init_db``; disposed at teardown so Windows can delete the temp dir.
- ``app`` / ``client``: the FastAPI app with ``get_db`` overridden, and a
  ``TestClient`` that is NOT entered as a context manager, so the lifespan (startup
  triage, periodic job) never runs. ``app.main`` is imported lazily.
- ``factory`` / ``world``: data factories (see ``tests/factories.py``).
- ``token_for`` / ``auth_headers``: bearer-token helpers.
"""
from __future__ import annotations

import os

os.environ["MAATRIVA_JWT_SECRET"] = "maatriva-test-secret-not-for-production"
os.environ["DATABASE_URL"] = "sqlite://"

from typing import Iterator  # noqa: E402

import pytest  # noqa: E402

from app import db  # noqa: E402
from app.config import get_settings  # noqa: E402
from tests import factories  # noqa: E402

get_settings.cache_clear()


@pytest.fixture(autouse=True)
def _fresh_settings() -> Iterator[None]:
    """Tests that monkeypatch the environment get a clean settings cache both ways."""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def db_engine(tmp_path):
    """Per-test SQLite file database with all tables and the SyncCounter row."""
    url = f"sqlite:///{(tmp_path / 't.db').as_posix()}"
    engine = db.configure_engine(url)
    db.init_db()
    try:
        yield engine
    finally:
        engine.dispose()
        db.engine = None
        db.SessionLocal = None


@pytest.fixture
def db_session(db_engine):
    """A session on the test database, closed (and rolled back if open) at teardown."""
    session = db.SessionLocal()
    try:
        yield session
    finally:
        session.close()


def _load_app():
    """Import ``app.main`` lazily: prefer the ``create_app()`` factory, else ``app``."""
    from app import main  # noqa: WPS433 (lazy on purpose)

    factory = getattr(main, "create_app", None)
    return factory() if callable(factory) else main.app


@pytest.fixture
def app(db_engine):
    application = _load_app()

    def _override_get_db():
        session = db.SessionLocal()
        try:
            yield session
        finally:
            session.close()

    application.dependency_overrides[db.get_db] = _override_get_db
    try:
        yield application
    finally:
        application.dependency_overrides.pop(db.get_db, None)


@pytest.fixture
def client(app):
    """HTTP client without lifespan (no ``with`` block, so startup never runs)."""
    from fastapi.testclient import TestClient

    test_client = TestClient(app)
    try:
        yield test_client
    finally:
        test_client.close()


@pytest.fixture
def factory(db_engine) -> factories.Factory:
    return factories.Factory()


@pytest.fixture
def world(factory) -> factories.World:
    """Two facilities (a, b), each with 2 villages, 2 ASHAs, an ANM, a doctor and
    one mother per village, plus one admin."""
    return factory.two_facilities()


@pytest.fixture
def token_for():
    return factories.token_for


@pytest.fixture
def auth_headers():
    return factories.auth_headers
