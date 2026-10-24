"""Deterministic seed (Requirements 6.6, 39.1, 39.10–39.14, 44.5).

Read-only checks run on a per-test copy of one module-level seeded database
(fixed seed day). The CLI test seeds from scratch through ``seed.main``.
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest
from sqlalchemy import func, select

from app import db, demo_data, seed
from app.config import get_settings
from app.models import (
    BirthOutcome,
    Mother,
    MotherStatus,
    RiskFlag,
    SyncCounter,
    Task,
    TaskStatus,
    User,
    UserVillage,
    Village,
    Visit,
)
from tests import seeding

SEED_DAY = date(2025, 3, 15)


@pytest.fixture(scope="module")
def seeded_template(tmp_path_factory):
    return seeding.build_template(tmp_path_factory.mktemp("seed-template"), SEED_DAY)


@pytest.fixture
def seeded(seeded_template, tmp_path):
    """A private copy of the seeded database; yields the seed report."""
    template, report = seeded_template
    seeding.open_copy(template, tmp_path)
    try:
        yield report
    finally:
        seeding.close_copy()


# --------------------------------------------------------------------------- counts


def test_counts_are_in_band(seeded):
    with db.SessionLocal() as s:
        report = seed.build_report(s, SEED_DAY)

    assert report.total_active == 120
    assert report.delivered == 10
    assert report.lbw == 2
    assert 8 <= report.red <= 12
    assert 30 <= report.amber <= 36
    assert 44 <= report.bpl <= 52
    assert report.bpl == seed.BPL_COUNT == 48
    assert report.green == 120 - report.red - report.amber
    assert all(c["total"] == 20 for c in report.per_village.values())
    # The report returned by seed() matches the database.
    assert (report.red, report.amber, report.bpl) == (seeded.red, seeded.amber, seeded.bpl)


def test_delivered_mothers_have_outcomes(seeded):
    with db.SessionLocal() as s:
        delivered = s.execute(
            select(Mother.id).where(Mother.status == MotherStatus.delivered.value)
        ).scalars().all()
        outcomes = s.execute(select(BirthOutcome)).scalars().all()
        active_flags = s.execute(
            select(func.count()).select_from(RiskFlag).where(
                RiskFlag.mother_id.in_(delivered), RiskFlag.active.is_(True)
            )
        ).scalar_one()

    assert sorted(o.mother_id for o in outcomes) == sorted(delivered)
    assert all(o.outcome == "live_birth" for o in outcomes)
    lbw = [o for o in outcomes if o.is_lbw]
    normal = [o for o in outcomes if not o.is_lbw]
    assert len(lbw) == 2 and all(2.1 <= o.birth_weight_kg <= 2.4 for o in lbw)
    assert len(normal) == 8 and all(2.6 <= o.birth_weight_kg <= 3.4 for o in normal)
    assert active_flags == 0


def test_closed_loop_history(seeded):
    with db.SessionLocal() as s:
        tasks = s.execute(select(Task)).scalars().all()

    done = [t for t in tasks if t.status == TaskStatus.done.value]
    open_ = [t for t in tasks if t.status == TaskStatus.open.value]
    overdue = [t for t in open_ if t.is_overdue(SEED_DAY)]
    assert (len(tasks), len(done), len(open_), len(overdue)) == (6, 2, 4, 2)
    assert all(t.alert_id is not None for t in tasks)
    assert len({t.mother_id for t in tasks}) == 6


# --------------------------------------------------------------------------- scoping


def test_every_user_village_pair_shares_the_users_facility(seeded):
    with db.SessionLocal() as s:
        seed.assert_user_villages_in_facility(s)  # raises on a bad pair
        rows = s.execute(
            select(User.username, User.facility_id, Village.name, Village.facility_id)
            .join(UserVillage, UserVillage.user_id == User.id)
            .join(Village, Village.id == UserVillage.village_id)
        ).all()
        admin = s.execute(select(User).where(User.username == "admin1")).scalar_one()

    assert rows and all(ufac == vfac for _, ufac, _, vfac in rows)
    assigned = {}
    for username, _, village, _ in rows:
        assigned.setdefault(username, set()).add(village)
    assert assigned == {
        "asha1": {"Dankaur", "Dadri"},
        "asha2": {"Bil Akbarpur", "Jhajhar"},
        "asha3": {"Rabupura", "Jewar"},
    }
    assert admin.facility_id is None


# --------------------------------------------------------------------------- demo mother


def test_demo_mother_is_green_with_her_seed_history(seeded):
    with db.SessionLocal() as s:
        m = s.get(Mother, demo_data.DEMO_MOTHER_ID)
        flags = s.execute(
            select(RiskFlag).where(RiskFlag.mother_id == m.id, RiskFlag.active.is_(True))
        ).scalars().all()
        visits = s.execute(
            select(Visit).where(Visit.mother_id == m.id).order_by(Visit.visit_date)
        ).scalars().all()
        asha = s.get(User, m.asha_id)
        village = s.get(Village, m.village_id)

    assert m.risk_level == "GREEN" and m.status == MotherStatus.active.value
    assert flags == []
    assert asha.username == "asha1" and village.name == "Dankaur"
    assert (SEED_DAY - m.lmp_date).days == 182  # GA 26w0d
    assert [v.id for v in visits] == demo_data.DEMO_VISIT_IDS
    last = visits[-1]
    assert last.visit_date == SEED_DAY - timedelta(days=30)
    assert (last.weight_kg, last.hb_gdl, last.bp_systolic, last.bp_diastolic) == (
        58.0, 11.4, 112, 72,
    )


# --------------------------------------------------------------------------- CLI + determinism


def _snapshot():
    with db.SessionLocal() as s:
        mothers = dict(s.execute(select(Mother.id, Mother.risk_level)).all())
        visits = sorted(s.execute(select(Visit.id)).scalars().all())
        tasks = sorted(s.execute(select(Task.id)).scalars().all())
        users = sorted(s.execute(select(User.id)).scalars().all())
        outcomes = sorted(s.execute(select(BirthOutcome.id)).scalars().all())
        epoch = s.get(SyncCounter, 1).epoch
    report_counts = sorted(mothers.values())
    return {
        "mothers": mothers,
        "visits": visits,
        "tasks": tasks,
        "users": users,
        "outcomes": outcomes,
        "levels": report_counts,
    }, epoch


def test_cli_modes_and_reset_determinism(db_engine, monkeypatch, capsys):
    monkeypatch.setenv("MAATRIVA_SEED_TODAY", SEED_DAY.isoformat())
    get_settings.cache_clear()

    # --if-empty on an empty database seeds it.
    assert seed.main(["--if-empty"]) == 0
    out = capsys.readouterr().out
    assert "RED " in out and "BPL 48" in out and SEED_DAY.isoformat() in out
    first, epoch0 = _snapshot()
    assert len(first["mothers"]) == 130

    # No flag on a seeded database: refuses with exit 1.
    assert seed.main([]) == 1
    assert "--reset" in capsys.readouterr().err

    # --if-empty on a seeded database: nothing to do.
    assert seed.main(["--if-empty"]) == 0
    assert "nothing to do" in capsys.readouterr().out
    assert _snapshot() == (first, epoch0)

    # Two --reset runs with the same seed day: identical ids and counts, new epochs.
    assert seed.main(["--reset"]) == 0
    second, epoch1 = _snapshot()
    assert seed.main(["--reset"]) == 0
    third, epoch2 = _snapshot()
    capsys.readouterr()

    assert first == second == third
    assert len({epoch0, epoch1, epoch2}) == 3
