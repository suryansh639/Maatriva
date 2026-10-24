"""Gestation calculations shared by triage, sync and the dashboard.

GA is the number of days from LMP to a date. EDD follows Naegele's rule:
LMP + 7 days, then + 9 calendar months with the day clamped to month end.
"""
from __future__ import annotations

import calendar
from datetime import date, timedelta


def ga_days(lmp: date, on: date) -> int:
    """Gestational age in days at ``on``."""
    return (on - lmp).days


def ga_label(days: int) -> str:
    """Display form ``{weeks}w {days}d``."""
    return f"{days // 7}w {days % 7}d"


def add_months_clamped(d: date, months: int) -> date:
    """Add calendar months, clamping the day to the target month's last day."""
    total = d.year * 12 + (d.month - 1) + months
    year, month0 = divmod(total, 12)
    month = month0 + 1
    last = calendar.monthrange(year, month)[1]
    return date(year, month, min(d.day, last))


def edd_naegele(lmp: date) -> date:
    """Estimated delivery date by Naegele's rule."""
    return add_months_clamped(lmp + timedelta(days=7), 9)


def trimester(ga: int) -> int:
    """1 below 98 days, 2 for 98-195, 3 from 196."""
    if ga < 98:
        return 1
    if ga < 196:
        return 2
    return 3
