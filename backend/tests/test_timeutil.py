"""Time helpers (Requirements 3.3, 4.6, 44.1)."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from app.timeutil import IST, ist_date, iso_z, to_utc_naive, utcnow


def test_iso_z_naive_utc() -> None:
    s = iso_z(datetime(2025, 1, 15, 10, 30, 0))
    assert s.endswith("Z")
    assert s == "2025-01-15T10:30:00Z"


def test_iso_z_converts_aware_to_utc() -> None:
    aware = datetime(2025, 1, 15, 16, 0, 0, tzinfo=IST)
    assert iso_z(aware) == "2025-01-15T10:30:00Z"


def test_iso_z_utcnow_ends_with_z() -> None:
    assert iso_z(utcnow()).endswith("Z")


def test_ist_date_before_1830_utc_is_same_day() -> None:
    assert ist_date(datetime(2025, 1, 15, 18, 29, 59)) == date(2025, 1, 15)


def test_ist_date_at_1830_utc_is_next_day() -> None:
    assert ist_date(datetime(2025, 1, 15, 18, 30, 0)) == date(2025, 1, 16)


def test_ist_date_year_boundary() -> None:
    assert ist_date(datetime(2024, 12, 31, 18, 30, 0)) == date(2025, 1, 1)


def test_ist_date_accepts_aware() -> None:
    aware = datetime(2025, 1, 15, 18, 30, 0, tzinfo=timezone.utc)
    assert ist_date(aware) == date(2025, 1, 16)


def test_ist_is_fixed_offset() -> None:
    assert IST.utcoffset(None) == timedelta(hours=5, minutes=30)


def test_to_utc_naive() -> None:
    aware = datetime(2025, 1, 16, 0, 0, 0, tzinfo=IST)
    assert to_utc_naive(aware) == datetime(2025, 1, 15, 18, 30, 0)
    naive = datetime(2025, 1, 15, 18, 30, 0)
    assert to_utc_naive(naive) == naive
