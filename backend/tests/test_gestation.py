"""Gestation calculations (Requirements 4.1, 4.3, 4.4, 44.1)."""
from __future__ import annotations

from datetime import date

import pytest

from app.gestation import edd_naegele, ga_days, ga_label, trimester


@pytest.mark.parametrize(
    ("lmp", "edd"),
    [
        (date(2024, 1, 1), date(2024, 10, 8)),
        (date(2024, 5, 25), date(2025, 3, 1)),
        (date(2023, 5, 24), date(2024, 2, 29)),  # leap-year Feb 29
        (date(2022, 5, 24), date(2023, 2, 28)),  # clamped to Feb 28
    ],
)
def test_edd_vectors(lmp: date, edd: date) -> None:
    assert edd_naegele(lmp) == edd


@pytest.mark.parametrize(
    ("ga", "expected"),
    [(0, 1), (97, 1), (98, 2), (195, 2), (196, 3), (308, 3)],
)
def test_trimester_boundaries(ga: int, expected: int) -> None:
    assert trimester(ga) == expected


def test_ga_days_counts_days_from_lmp() -> None:
    assert ga_days(date(2024, 1, 1), date(2024, 1, 1)) == 0
    assert ga_days(date(2024, 1, 1), date(2024, 3, 1)) == 60  # spans leap Feb


@pytest.mark.parametrize(
    ("days", "label"),
    [(0, "0w 0d"), (6, "0w 6d"), (7, "1w 0d"), (182, "26w 0d"), (185, "26w 3d")],
)
def test_ga_label(days: int, label: str) -> None:
    assert ga_label(days) == label
