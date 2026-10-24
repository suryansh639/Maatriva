"""Test data factories and the token helper (Requirement 44.1).

Every factory call runs in its own short writing transaction that starts with
``db.begin_write`` (design §3), so rows carry a real Change_Seq exactly as
production writes do. Objects are returned detached (``expire_on_commit=False``):
read their columns freely, but re-query inside a session for relationships.

Passwords are hashed with a reduced PBKDF2 iteration count for speed;
``verify_password`` reads the count from the stored hash, so login still works.
"""
from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from functools import lru_cache
from typing import Dict, Iterable, List, Optional, Sequence

from app import db
from app.config import get_settings
from app.gestation import edd_naegele
from app.models import Facility, Mother, User, UserVillage, Village, new_uuid
from app.security import hash_password, issue_token
from app.timeutil import IST, to_utc_naive, today_ist, utcnow

TEST_PASSWORD = "test-pass-123"
TEST_HASH_ITERATIONS = 1_000


@lru_cache(maxsize=None)
def fast_hash(password: str) -> str:
    """Reduced-iteration hash, cached per password (salt reuse is fine in tests)."""
    return hash_password(password, iterations=TEST_HASH_ITERATIONS)


def ist_datetime(d: date, hh: int = 9, mm: int = 0) -> datetime:
    """``d`` at ``hh:mm`` IST, as naive UTC."""
    return to_utc_naive(datetime.combine(d, time(hh, mm), tzinfo=IST))


# --------------------------------------------------------------------------- token helper


def token_for(user: User, now: Optional[datetime] = None) -> str:
    token, _expires = issue_token(user, get_settings(), now)
    return token


def auth_headers(user: User, now: Optional[datetime] = None) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token_for(user, now)}"}


# --------------------------------------------------------------------------- factories


class Factory:
    """Creates committed rows in the currently configured test database."""

    def __init__(self) -> None:
        self._n = itertools.count(1)

    def _next(self) -> int:
        return next(self._n)

    def facility(self, name: Optional[str] = None, **kw) -> Facility:
        n = self._next()
        values = dict(
            id=new_uuid(),
            name=name or f"Test PHC {n}",
            district="Test District",
            state="Test State",
            lat=28.40 + n / 100,
            lng=77.50 + n / 100,
        )
        values.update(kw)
        with db.SessionLocal() as s:
            db.begin_write(s)
            row = Facility(**values)
            s.add(row)
            s.commit()
        return row

    def village(self, facility: Facility, name: Optional[str] = None, **kw) -> Village:
        n = self._next()
        values = dict(
            id=new_uuid(),
            name=name or f"Village {n}",
            facility_id=facility.id,
            lat=facility.lat + 0.01 * (n % 7),
            lng=facility.lng + 0.01 * (n % 5),
        )
        values.update(kw)
        with db.SessionLocal() as s:
            db.begin_write(s)
            row = Village(**values)
            s.add(row)
            s.commit()
        return row

    def user(
        self,
        role: str,
        facility: Optional[Facility] = None,
        *,
        username: Optional[str] = None,
        villages: Iterable[Village] = (),
        password: str = TEST_PASSWORD,
        **kw,
    ) -> User:
        """``villages`` creates UserVillage rows. Cross-facility assignments are
        allowed here on purpose, so scoping tests can check they are filtered."""
        n = self._next()
        values = dict(
            id=new_uuid(),
            username=username or f"{role}{n}",
            password_hash=fast_hash(password),
            full_name=f"Test {role.upper()} {n}",
            role=role,
            facility_id=facility.id if facility is not None else None,
            phone=None,
        )
        values.update(kw)
        with db.SessionLocal() as s:
            db.begin_write(s)
            row = User(**values)
            s.add(row)
            s.flush()
            for v in villages:
                s.add(UserVillage(user_id=row.id, village_id=v.id))
            s.commit()
        return row

    def assign(self, user: User, *villages: Village) -> None:
        with db.SessionLocal() as s:
            db.begin_write(s)
            for v in villages:
                s.add(UserVillage(user_id=user.id, village_id=v.id))
            s.commit()

    def mother(
        self,
        village: Village,
        asha: User,
        *,
        ga: int = 120,
        today: Optional[date] = None,
        **kw,
    ) -> Mother:
        """An active GREEN mother with LMP ``ga`` days before ``today`` (IST),
        registered at GA 60 (or today when earlier) at 09:00 IST."""
        n = self._next()
        today = today or today_ist()
        lmp = kw.pop("lmp_date", None) or today - timedelta(days=ga)
        reg_day = min(lmp + timedelta(days=60), today)
        registered_at = kw.pop("registered_at", None) or min(ist_datetime(reg_day), utcnow())
        values = dict(
            id=new_uuid(),
            full_name=f"Test Mother {n}",
            age=25,
            guardian_name=f"Test Guardian {n}",
            village_id=village.id,
            facility_id=village.facility_id,
            asha_id=asha.id,
            phone=None,
            lmp_date=lmp,
            edd_date=edd_naegele(lmp),
            is_bpl=False,
            height_cm=155.0,
            first_weight_kg=52.0,
            registered_at=registered_at,
            status="active",
            risk_level="GREEN",
            updated_at=registered_at,
        )
        values.update(kw)
        with db.SessionLocal() as s:
            seq = db.begin_write(s)
            row = Mother(**values, change_seq=seq)
            s.add(row)
            s.commit()
        return row

    # ----------------------------------------------------------------- canned world

    def facility_world(self, key: str, mothers_per_village: int = 1) -> "FacilityWorld":
        fac = self.facility(name=f"PHC {key.upper()}")
        v1 = self.village(fac, name=f"Village {key.upper()}1")
        v2 = self.village(fac, name=f"Village {key.upper()}2")
        asha = self.user("asha", fac, username=f"asha_{key}", villages=[v1])
        asha2 = self.user("asha", fac, username=f"asha2_{key}", villages=[v2])
        anm = self.user("anm", fac, username=f"anm_{key}", villages=[v1, v2])
        doctor = self.user("doctor", fac, username=f"doctor_{key}")
        mothers: List[Mother] = []
        for village, owner in ((v1, asha), (v2, asha2)):
            for _ in range(mothers_per_village):
                mothers.append(self.mother(village, owner))
        return FacilityWorld(
            facility=fac,
            villages=[v1, v2],
            asha=asha,
            asha2=asha2,
            anm=anm,
            doctor=doctor,
            mothers=mothers,
        )

    def two_facilities(self, mothers_per_village: int = 1) -> "World":
        a = self.facility_world("a", mothers_per_village)
        b = self.facility_world("b", mothers_per_village)
        admin = self.user("admin", None, username="admin")
        return World(a=a, b=b, admin=admin)


@dataclass
class FacilityWorld:
    """One PHC: villages[0] belongs to ``asha``, villages[1] to ``asha2``; the ANM
    covers both; the doctor has no village rows. ``mothers`` are listed village by
    village, each registered by that village's ASHA."""

    facility: Facility
    villages: List[Village]
    asha: User
    asha2: User
    anm: User
    doctor: User
    mothers: List[Mother] = field(default_factory=list)

    def mothers_in(self, village: Village) -> List[Mother]:
        return [m for m in self.mothers if m.village_id == village.id]

    @property
    def users(self) -> Sequence[User]:
        return (self.asha, self.asha2, self.anm, self.doctor)


@dataclass
class World:
    """Two facilities ``a`` and ``b`` plus one admin (no facility)."""

    a: FacilityWorld
    b: FacilityWorld
    admin: User


__all__ = [
    "TEST_PASSWORD",
    "TEST_HASH_ITERATIONS",
    "Factory",
    "FacilityWorld",
    "World",
    "auth_headers",
    "fast_hash",
    "ist_datetime",
    "token_for",
]
