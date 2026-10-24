"""The seeded demo mother (Requirements 39.10, 40.4, 40.5; design §14).

Pure data: no database access. ``build_demo_mother_history(today)`` is used by
both ``app.seed`` and ``POST /api/demo/reset`` (``routers/demo.py``), so the demo
mother's history is identical after a reseed and after a demo reset.

With ``D(n) = today - n days``:

- LMP = ``D(182)`` (GA 26w0d today), registered at ``D(126)`` 09:00 IST (GA 8w0d,
  not late), height 155 cm, ``first_weight_kg`` 52.0 (BMI 21.6), not BPL.
- Visits (ids ``…a1`` to ``…a4``, ``device_id = "seed"``):

  | visit   | GA     | weight  | Hb   | BP     |
  |---------|--------|---------|------|--------|
  | D(126)  | 8w0d   | –       | 11.6 | 110/70 |
  | D(98)   | 12w0d  | 54.0 kg | 11.5 | 112/72 |
  | D(70)   | 16w0d  | 55.3 kg | 11.3 | 114/74 |
  | D(30)   | 21w5d  | 58.0 kg | 11.4 | 112/72 |

  Pair gains are 0.33 and 0.47 kg/week; ``D(70)`` is only 40 days before ``D(30)``
  so ``WEIGHT_STATIC`` has no reference; the last visit is 30 days old (<= 35), so
  she is GREEN until ``today + 5``.
- A field visit today with 56.6 kg and Hb 6.8 yields ``HB_SEVERE`` and
  ``WEIGHT_LOSS`` (GA 26w > 20w, reference ``D(30)`` 30 days earlier, loss 1.4 kg).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import List, Optional, Tuple

from app.timeutil import IST, to_utc_naive

DEMO_MOTHER_ID = "00000000-0000-4000-8000-000000000001"
DEMO_VISIT_IDS: List[str] = [f"00000000-0000-4000-8000-0000000000a{i}" for i in range(1, 5)]

DEMO_MOTHER_NAME = "Sunita Demo (synthetic)"
DEMO_GUARDIAN_NAME = "Ramesh Demo (synthetic)"
DEMO_MOTHER_AGE = 24
DEMO_VILLAGE_NAME = "Dankaur"
DEMO_ASHA_USERNAME = "asha1"
DEMO_HEIGHT_CM = 155.0
DEMO_FIRST_WEIGHT_KG = 52.0
DEMO_SEED_DEVICE_ID = "seed"
DEMO_TRIGGER_DEVICE_ID = "demo-trigger"

DEMO_LMP_DAYS_AGO = 182
DEMO_REGISTERED_DAYS_AGO = 126

# (days before today, weight_kg, hb_gdl, systolic, diastolic)
_DEMO_VISIT_ROWS: Tuple[Tuple[int, Optional[float], float, int, int], ...] = (
    (126, None, 11.6, 110, 70),
    (98, 54.0, 11.5, 112, 72),
    (70, 55.3, 11.3, 114, 74),
    (30, 58.0, 11.4, 112, 72),
)
DEMO_IFA_TABLETS = 30
DEMO_CALCIUM_TABLETS = 60

# Demo trigger visit (Req 40.3): last seeded weight minus 1.4 kg, Hb 6.8.
DEMO_TRIGGER_WEIGHT_DROP_KG = 1.4
DEMO_TRIGGER_HB = 6.8


def ist_at(day: date, hour: int, minute: int = 0) -> datetime:
    """``day`` at ``hour:minute`` IST, as naive UTC."""
    return to_utc_naive(datetime.combine(day, time(hour, minute), tzinfo=IST))


@dataclass(frozen=True)
class DemoVisit:
    id: str
    visit_date: date
    weight_kg: Optional[float]
    hb_gdl: float
    bp_systolic: int
    bp_diastolic: int
    ifa_tablets: int
    calcium_tablets: int
    client_created_at: datetime  # naive UTC (visit day 10:00 IST)

    @property
    def weight_source(self) -> Optional[str]:
        return "manual" if self.weight_kg is not None else None


@dataclass(frozen=True)
class DemoHistory:
    lmp_date: date
    registered_at: datetime  # naive UTC (registration day 09:00 IST)
    height_cm: float
    first_weight_kg: float
    visits: List[DemoVisit]

    @property
    def last_weight_kg(self) -> float:
        return next(v.weight_kg for v in reversed(self.visits) if v.weight_kg is not None)


def build_demo_mother_history(today: date) -> DemoHistory:
    """The demo mother's LMP, registration and four seed visits relative to ``today``."""

    def d(n: int) -> date:
        return today - timedelta(days=n)

    visits = [
        DemoVisit(
            id=DEMO_VISIT_IDS[i],
            visit_date=d(days_ago),
            weight_kg=weight,
            hb_gdl=hb,
            bp_systolic=sys_,
            bp_diastolic=dia,
            ifa_tablets=DEMO_IFA_TABLETS,
            calcium_tablets=DEMO_CALCIUM_TABLETS,
            client_created_at=ist_at(d(days_ago), 10),
        )
        for i, (days_ago, weight, hb, sys_, dia) in enumerate(_DEMO_VISIT_ROWS)
    ]
    return DemoHistory(
        lmp_date=d(DEMO_LMP_DAYS_AGO),
        registered_at=ist_at(d(DEMO_REGISTERED_DAYS_AGO), 9),
        height_cm=DEMO_HEIGHT_CM,
        first_weight_kg=DEMO_FIRST_WEIGHT_KG,
        visits=visits,
    )


__all__ = [
    "DEMO_MOTHER_ID",
    "DEMO_VISIT_IDS",
    "DEMO_MOTHER_NAME",
    "DEMO_GUARDIAN_NAME",
    "DEMO_MOTHER_AGE",
    "DEMO_VILLAGE_NAME",
    "DEMO_ASHA_USERNAME",
    "DEMO_HEIGHT_CM",
    "DEMO_FIRST_WEIGHT_KG",
    "DEMO_SEED_DEVICE_ID",
    "DEMO_TRIGGER_DEVICE_ID",
    "DEMO_IFA_TABLETS",
    "DEMO_CALCIUM_TABLETS",
    "DEMO_TRIGGER_WEIGHT_DROP_KG",
    "DEMO_TRIGGER_HB",
    "DemoVisit",
    "DemoHistory",
    "ist_at",
    "build_demo_mother_history",
]
