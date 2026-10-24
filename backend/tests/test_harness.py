"""Self-checks for the pytest harness: temp DB, factories, token helper, for_all."""
from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import func, select

from app import db
from app.config import BACKEND_DIR, get_settings
from app.gestation import edd_naegele
from app.models import Facility, Mother, SyncCounter, User, UserVillage, Village
from app.security import decode_token, verify_password
from tests import pbt
from tests.factories import TEST_PASSWORD


def test_settings_use_test_secret_and_no_real_db() -> None:
    settings = get_settings()
    assert settings.jwt_secret == "maatriva-test-secret-not-for-production"
    assert settings.database_url == "sqlite://"


def test_db_engine_is_temp_file_with_counter(db_engine, tmp_path) -> None:
    db_file = Path(db_engine.url.database)
    assert db_file.parent == tmp_path
    assert BACKEND_DIR not in db_file.parents
    with db.SessionLocal() as s:
        counter = s.get(SyncCounter, 1)
        assert counter is not None and counter.value == 0 and len(counter.epoch) == 36
        assert db.begin_write(s) == 1
        s.commit()
        assert db.begin_write(s) == 2
        s.rollback()
        assert s.get(SyncCounter, 1).value == 1


def test_databases_are_isolated_per_test(db_session) -> None:
    # Runs after the test above; a shared DB would already hold value >= 1.
    assert db_session.get(SyncCounter, 1).value == 0


def test_world_shape_and_invariants(world, db_session) -> None:
    s = db_session
    assert s.scalar(select(func.count()).select_from(Facility)) == 2
    assert s.scalar(select(func.count()).select_from(Village)) == 4
    assert s.scalar(select(func.count()).select_from(User)) == 9
    assert s.scalar(select(func.count()).select_from(Mother)) == 4

    roles = sorted(s.scalars(select(User.role)).all())
    assert roles == ["admin"] + ["anm"] * 2 + ["asha"] * 4 + ["doctor"] * 2
    assert world.admin.facility_id is None

    for fw in (world.a, world.b):
        for u in fw.users:
            assert u.facility_id == fw.facility.id
        for v in fw.villages:
            assert v.facility_id == fw.facility.id
        for m in fw.mothers:
            assert m.facility_id == fw.facility.id
            assert m.edd_date == edd_naegele(m.lmp_date)
            assert m.lmp_date <= m.registered_at.date()
            assert m.status == "active" and m.risk_level == "GREEN"
        assert [m.asha_id for m in fw.mothers] == [fw.asha.id, fw.asha2.id]

    # Every UserVillage row stays inside the user's facility.
    rows = s.execute(
        select(User.facility_id, Village.facility_id)
        .join(UserVillage, UserVillage.user_id == User.id)
        .join(Village, Village.id == UserVillage.village_id)
    ).all()
    assert rows and all(uf == vf for uf, vf in rows)

    # Change_Seq stamped from begin_write and strictly increasing by creation order.
    seqs = [s.get(Mother, m.id).change_seq for m in world.a.mothers + world.b.mothers]
    assert seqs == sorted(seqs) and len(set(seqs)) == 4 and seqs[0] >= 1


def test_factory_password_and_token(world) -> None:
    from tests.factories import token_for

    doctor = world.a.doctor
    assert verify_password(TEST_PASSWORD, doctor.password_hash)
    assert not verify_password("wrong", doctor.password_hash)
    claims = decode_token(token_for(doctor))
    assert claims["sub"] == doctor.id
    assert claims["role"] == "doctor"
    assert claims["fac"] == world.a.facility.id
    assert decode_token(token_for(world.admin))["fac"] is None


def test_auth_headers_fixture(world, auth_headers) -> None:
    headers = auth_headers(world.b.asha)
    assert headers["Authorization"].startswith("Bearer ")
    assert decode_token(headers["Authorization"][7:])["sub"] == world.b.asha.id


def test_client_without_lifespan(request) -> None:
    pytest.importorskip("app.main")
    client = request.getfixturevalue("client")
    assert client.get("/api/health").status_code == 200


# --------------------------------------------------------------------------- pbt


def _gen_int(rng):
    return rng.randint(0, 10_000)


def test_for_all_is_deterministic_and_keeps_fixtures(tmp_path) -> None:
    seen = []

    @pbt.for_all(_gen_int, _gen_int, runs=20, seed=7)
    def prop(a, b, tmp):
        assert tmp == tmp_path
        seen.append((a, b))

    prop(tmp_path)
    first = list(seen)
    seen.clear()
    prop(tmp_path)
    assert seen == first and len(first) == 20
    assert first == [pbt.draw([_gen_int, _gen_int], 7, i) for i in range(20)]


def test_for_all_hides_generated_params_from_pytest() -> None:
    import inspect

    @pbt.for_all(_gen_int)
    def prop(a, db_engine):
        pass

    assert list(inspect.signature(prop).parameters) == ["db_engine"]


def test_for_all_reports_seed_iteration_and_example(monkeypatch) -> None:
    monkeypatch.delenv("PBT_REPLAY", raising=False)
    monkeypatch.delenv("PBT_RUNS", raising=False)

    @pbt.for_all(_gen_int, runs=200, seed=11)
    def prop(a):
        assert a % 3 != 0

    with pytest.raises(pbt.PropertyFailure) as info:
        prop()
    msg = str(info.value)
    i = next(i for i in range(200) if pbt.draw([_gen_int], 11, i)[0] % 3 == 0)
    assert f"iteration {i} with seed 11" in msg
    assert f"PBT_SEED=11 PBT_REPLAY={i}" in msg
    assert repr(pbt.draw([_gen_int], 11, i)[0]) in msg
    assert isinstance(info.value.__cause__, AssertionError)

    # Replaying exactly that iteration reproduces the failure on its own.
    monkeypatch.setenv("PBT_REPLAY", str(i))
    with pytest.raises(pbt.PropertyFailure, match=f"iteration {i} "):
        prop()


def test_for_all_seed_from_env(monkeypatch) -> None:
    monkeypatch.setenv("PBT_SEED", "99")
    monkeypatch.setenv("PBT_RUNS", "5")
    seen = []

    @pbt.for_all(_gen_int)
    def prop(a):
        seen.append(a)

    prop()
    assert seen == [pbt.draw([_gen_int], 99, i)[0] for i in range(5)]
