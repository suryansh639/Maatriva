"""Time helpers.

Storage convention: datetimes are naive UTC; serialization is ISO-8601 with a
``Z`` suffix; "today" is the IST calendar date. IST is a fixed UTC+05:30
offset (no zoneinfo; Python 3.10 compatible).
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))


def utcnow() -> datetime:
    """Current time as naive UTC."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def to_utc_naive(dt: datetime) -> datetime:
    """Convert an aware datetime to naive UTC; a naive datetime is assumed UTC."""
    if dt.tzinfo is None or dt.tzinfo.utcoffset(dt) is None:
        return dt.replace(tzinfo=None)
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


def iso_z(dt: datetime) -> str:
    """Serialize as ``YYYY-MM-DDTHH:MM:SS[.ffffff]Z`` (input converted to UTC)."""
    return to_utc_naive(dt).isoformat() + "Z"


def ist_date(dt_naive_utc: datetime) -> date:
    """IST calendar date of a naive-UTC (or aware) datetime."""
    return to_utc_naive(dt_naive_utc).replace(tzinfo=timezone.utc).astimezone(IST).date()


def today_ist() -> date:
    """Today's IST calendar date."""
    return ist_date(utcnow())
