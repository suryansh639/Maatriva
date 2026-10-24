"""Deterministic synthetic seed (Requirements 6.6, 39.1–39.14; design §15).

Usage (from ``backend/``)::

    python -m app.seed              # exits 1 with a message when data exists
    python -m app.seed --reset      # drop + create tables (new Sync_Epoch), then seed
    python -m app.seed --if-empty   # seed only when no facility exists (start.ps1)

Determinism: ``random.Random(20250101)`` is the only randomness source for
structure, values and the ids of the facility, villages, users, mothers, visits,
tasks and birth outcomes (``new_id(rng)``). The rng is consumed in a fixed order
(base data, BPL sample, village slots, mothers, delivered mothers, loop ids), all
before any database write, so database behaviour can never shift it. Dates are
relative to the seed day (``MAATRIVA_SEED_TODAY`` or the IST date today); triage
runs with ``now`` = 06:00 IST on the seed day. Flags, alerts and mock SMS rows are
created by the real services and use random server ids.

Generation (pure, ``plan_visits`` + generate-and-verify):

1. GA is drawn first, uniformly over 6–39 weeks (42–273 days).
2. A profile is drawn from the remaining profile slots that this GA supports
   (``WEIGHT_LOSS``/``WEIGHT_STATIC`` >= 154 days, ``WEIGHT_GAIN_LOW`` >= 112).
3. ``plan_visits`` places ``clamp((ga - 35) // 28 + 1, 1, 6)`` visits backwards
   from the seed day minus 3–25 days (36–60 for ``VISIT_OVERDUE``), spaced 21–35
   days apart, never before LMP + 35 days. The gap draw is narrowed inside 21–35
   when needed so the first visit lands at GA <= 84 (registration is the first
   visit, 09:00 IST). ``LATE_REG`` mothers register at GA 90–120, so their
   placement floor is GA 90 instead of 35 (no visit can precede registration).
4. The pure ``triage.evaluate`` checks the plan; on a mismatch the mother is
   redrawn from step 1 (same rng), at most 100 times, else ``SeedPlanError``.

Expected result: 120 active mothers (20 per village, demo mother in Dankaur),
RED 8, AMBER 35, GREEN 77, BPL 48, plus 10 delivered mothers (2 LBW).

Logs and output carry ids and counts only (Req 46.4).
"""
from __future__ import annotations

import argparse
import logging
import math
import random
import sys
import uuid
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Callable, Dict, FrozenSet, List, Optional, Sequence, Tuple

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import db, demo_data, outcome_service, task_service, triage
from app.config import get_settings
from app.demo_data import ist_at
from app.deps import load_current_user
from app.gestation import edd_naegele
from app.models import (
    Alert,
    AlertSeverity,
    AlertStatus,
    BirthOutcome,
    Facility,
    Mother,
    MotherStatus,
    RiskLevel,
    Role,
    User,
    UserVillage,
    Village,
    Visit,
)
from app.schemas import BirthOutcomeIn, TaskCompleteIn, TaskCreateIn
from app.security import hash_password
from app.sync_service import apply_task_complete
from app.timeutil import today_ist
from app.triage_service import apply_triage

log = logging.getLogger(__name__)

RNG_SEED = 20250101
DEMO_PASSWORD = "demo1234"
MAX_ATTEMPTS = 100

GA_MIN_DAYS = 42  # 6w0d
GA_MAX_DAYS = 273  # 39w0d
VISIT_FLOOR_GA = 35  # no visit before LMP + 35 days
FIRST_VISIT_GA_MAX = 84  # registered by 12w0d (not late)
LATE_REG_FIRST_GA = (90, 120)
GAP_DAYS = (21, 35)
MAX_VISITS = 6
UNWEIGHED_GA_MAX = 91  # visits at GA <= 91 days carry no weight
IFA_FROM_GA = 84  # IFA/calcium after 12 weeks

ACTIVE_MOTHERS = 120
MOTHERS_PER_VILLAGE = 20
BPL_COUNT = 48
DELIVERED_MOTHERS = 10
LBW_BIRTHS = 2


class SeedPlanError(RuntimeError):
    """A profile could not be planned within ``MAX_ATTEMPTS`` draws (a seed bug)."""


def new_id(rng: random.Random) -> str:
    """Deterministic lowercase uuid4 string from ``rng``."""
    return str(uuid.UUID(int=rng.getrandbits(128), version=4))


# --------------------------------------------------------------------------- base data

FACILITY = {
    "name": "Demo PHC – Dankaur Block (synthetic)",
    "district": "Gautam Buddh Nagar",
    "state": "Uttar Pradesh",
    "lat": 28.351,
    "lng": 77.554,
}

# (name, lat, lng): approximate demo coordinates.
VILLAGES: Tuple[Tuple[str, float, float], ...] = (
    ("Dadri", 28.553, 77.553),
    ("Bil Akbarpur", 28.572, 77.618),
    ("Dankaur", 28.351, 77.554),
    ("Rabupura", 28.255, 77.609),
    ("Jhajhar", 28.268, 77.524),
    ("Jewar", 28.122, 77.556),
)

# (username, full_name, role, villages, phone)
USERS: Tuple[Tuple[str, str, str, Tuple[str, ...], str], ...] = (
    ("doctor1", "Dr. Kavya (Demo)", Role.doctor.value, (), "9000000001"),
    ("anm1", "ANM Rekha (Demo)", Role.anm.value, (), "9000000002"),
    ("asha1", "ASHA Meena (Demo)", Role.asha.value, ("Dankaur", "Dadri"), "9000000011"),
    ("asha2", "ASHA Pooja (Demo)", Role.asha.value, ("Bil Akbarpur", "Jhajhar"), "9000000012"),
    ("asha3", "ASHA Anita (Demo)", Role.asha.value, ("Rabupura", "Jewar"), "9000000013"),
    ("admin1", "Admin (Demo)", Role.admin.value, (), "9000000099"),
)

FIRST_NAMES = (
    "Aarti", "Anjali", "Babita", "Champa", "Deepa", "Durga", "Geeta", "Guddi",
    "Heena", "Jyoti", "Kamla", "Kiran", "Lata", "Mamta", "Manju", "Meera",
    "Neelam", "Nisha", "Pinki", "Poonam", "Preeti", "Radha", "Rani", "Rekha",
    "Reena", "Ritu", "Sapna", "Savita", "Seema", "Shanti", "Sonam", "Suman",
    "Sushma", "Usha", "Vandana", "Varsha",
)
GUARDIAN_NAMES = (
    "Ajay", "Amit", "Anil", "Arjun", "Deepak", "Dinesh", "Gopal", "Harish",
    "Jitendra", "Kamal", "Lalit", "Mahesh", "Manoj", "Mukesh", "Naresh", "Pankaj",
    "Rajesh", "Rakesh", "Ravi", "Sanjay", "Sunil", "Suresh", "Vijay", "Vinod",
)
NAME_TAG = "Demo"


# --------------------------------------------------------------------------- profiles


@dataclass(frozen=True)
class Profile:
    """A seed risk profile. ``codes`` is the exact code set the final plan must
    produce (``allowed_extra`` codes may also appear). ``loop`` marks the 6
    closed-loop RED mothers: ``done`` (task done, Hb improved), ``open`` and
    ``overdue``."""

    key: str
    code: Optional[str]
    min_ga: int = GA_MIN_DAYS
    last_offset: Tuple[int, int] = (3, 25)
    loop: Optional[str] = None
    allowed_extra: FrozenSet[str] = frozenset()

    @property
    def intended_codes(self) -> FrozenSet[str]:
        if self.loop == "done":
            return frozenset({"HB_MODERATE"})
        return frozenset({self.code}) if self.code else frozenset()

    @property
    def phase_a_codes(self) -> FrozenSet[str]:
        """Codes at the task day, before the task (closed-loop mothers only)."""
        return frozenset({self.code}) if self.code else frozenset()


# Closed-loop task days (days before the seed day) and task shapes.
LOOP_TASK_DAYS_AGO = {"done": 20, "overdue": 10, "open": 1}
LOOP_DUE_AFTER_DAYS = {"done": 2, "overdue": 2, "open": 2}
LOOP_ACTION = {"done": "IFA_PER_PROTOCOL", "overdue": "REFER_PHC", "open": "HOME_VISIT_48H"}
LOOP_DONE_NOTE = "Visited, IFA given (synthetic)"
FOLLOWUP_AFTER_TASK_DAYS = (5, 15)
FOLLOWUP_HB = (8.5, 9.5)

PROFILES: Dict[str, Profile] = {
    p.key: p
    for p in (
        # RED (10): 6 of them get closed-loop history.
        Profile("HB_SEVERE/done", "HB_SEVERE", min_ga=63, last_offset=(21, 25), loop="done"),
        Profile("HB_SEVERE/open", "HB_SEVERE", min_ga=63, loop="open"),
        Profile("BP_SEVERE/overdue", "BP_SEVERE", min_ga=63, last_offset=(11, 25), loop="overdue"),
        Profile("WEIGHT_LOSS", "WEIGHT_LOSS", min_ga=154, allowed_extra=frozenset({"WEIGHT_STATIC"})),
        Profile("WEIGHT_STATIC", "WEIGHT_STATIC", min_ga=154),
        # AMBER (33)
        Profile("HB_MODERATE", "HB_MODERATE"),
        Profile("HB_MILD", "HB_MILD"),
        Profile("BP_HIGH", "BP_HIGH"),
        Profile("WEIGHT_GAIN_LOW", "WEIGHT_GAIN_LOW", min_ga=112),
        Profile("BMI_LOW", "BMI_LOW"),
        Profile("LATE_REG", "LATE_REG", min_ga=112),
        Profile("VISIT_OVERDUE", "VISIT_OVERDUE", min_ga=84, last_offset=(36, 60)),
        # GREEN (76 generated + the demo mother)
        Profile("GREEN", None),
    )
}

PROFILE_COUNTS: Dict[str, int] = {
    "HB_SEVERE/done": 2,
    "HB_SEVERE/open": 2,
    "BP_SEVERE/overdue": 2,
    "WEIGHT_LOSS": 2,
    "WEIGHT_STATIC": 2,
    "HB_MODERATE": 8,
    "HB_MILD": 7,
    "BP_HIGH": 5,
    "WEIGHT_GAIN_LOW": 4,
    "BMI_LOW": 3,
    "LATE_REG": 3,
    "VISIT_OVERDUE": 3,
    "GREEN": 76,
}
assert sum(PROFILE_COUNTS.values()) == ACTIVE_MOTHERS - 1


def eligible_profiles(remaining: Dict[str, int], ga: int) -> List[str]:
    """One entry per remaining slot whose profile this GA supports (stable order)."""
    return [
        key
        for key in PROFILE_COUNTS
        for _ in range(remaining.get(key, 0))
        if PROFILES[key].min_ga <= ga
    ]


# --------------------------------------------------------------------------- visit plans


@dataclass(frozen=True)
class PlannedVisit:
    visit_date: date
    weight_kg: Optional[float]
    hb_gdl: float
    bp_systolic: int
    bp_diastolic: int
    ifa_tablets: int
    calcium_tablets: int
    thr_received: bool

    @property
    def client_created_at(self) -> datetime:
        return ist_at(self.visit_date, 10)


@dataclass(frozen=True)
class VisitPlan:
    profile: str
    ga_days: int
    lmp_date: date
    height_cm: float
    first_weight_kg: float
    visits: Tuple[PlannedVisit, ...]
    followup: Optional[PlannedVisit] = None  # closed-loop "done" only, after the task

    @property
    def registered_on(self) -> date:
        return self.visits[0].visit_date

    @property
    def registered_at(self) -> datetime:
        return ist_at(self.registered_on, 9)


def _clamp(x: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, x))


def visit_count(ga: int) -> int:
    """Req 39.7: ``clamp((ga_days - 35) // 28 + 1, 1, 6)``."""
    return _clamp((ga - VISIT_FLOOR_GA) // 28 + 1, 1, MAX_VISITS)


def loop_task_day(profile: Profile, seed_day: date) -> Optional[date]:
    if profile.loop is None:
        return None
    return seed_day - timedelta(days=LOOP_TASK_DAYS_AGO[profile.loop])


def _schedule(rng: random.Random, ga: int, profile: Profile) -> Optional[List[int]]:
    """Visit GAs (ascending), or None when the profile cannot fit this GA."""
    n = visit_count(ga)
    late = profile.key == "LATE_REG"
    floor_ga, first_hi = (LATE_REG_FIRST_GA if late else (VISIT_FLOOR_GA, FIRST_VISIT_GA_MAX))
    gap_lo, gap_hi = GAP_DAYS
    o_lo, o_hi = profile.last_offset
    # Leave room for the first visit to reach GA <= first_hi with n - 1 gaps.
    o_lo = max(o_lo, ga - first_hi - (n - 1) * gap_hi)
    o_hi = min(o_hi, ga - floor_ga)
    if o_lo > o_hi:
        return None
    gas = [ga - rng.randint(o_lo, o_hi)]
    while len(gas) < n:
        cur = gas[-1]
        need = cur - first_hi
        lo = gap_lo if need <= 0 else min(gap_hi, max(gap_lo, math.ceil(need / (n - len(gas)))))
        hi = min(gap_hi, cur - floor_ga)
        if hi < lo:
            break  # the floor stops placement
        gas.append(cur - rng.randint(lo, hi))
    gas.reverse()
    return gas


def _green_hb(rng: random.Random) -> float:
    return round(rng.uniform(11.0, 12.8), 1)


def _green_bp(rng: random.Random) -> Tuple[int, int]:
    return rng.randint(100, 130), rng.randint(60, 85)


def plan_visits(
    rng: random.Random,
    ga: int,
    profile: Profile,
    seed_day: date,
    *,
    is_bpl: bool = False,
) -> Optional[VisitPlan]:
    """Pure visit plan for one mother at GA ``ga`` (days) on ``seed_day``.

    Returns None when the schedule cannot satisfy the profile's constraints (the
    caller redraws). The result still has to pass ``verify_plan``.
    """
    gas = _schedule(rng, ga, profile)
    if not gas:
        return None
    lmp = seed_day - timedelta(days=ga)
    height = float(rng.randint(145, 165))
    bmi = rng.uniform(16.5, 18.2) if profile.key == "BMI_LOW" else rng.uniform(19.5, 25.0)
    first_weight = round(bmi * (height / 100.0) ** 2, 1)

    # Weight trajectory: 0.15 kg/week up to 13 weeks, then a per-interval rate.
    low_gain = profile.key == "WEIGHT_GAIN_LOW"
    weights: List[Optional[float]] = []
    raw = first_weight + 0.15 * UNWEIGHED_GA_MAX / 7.0
    prev_ga = UNWEIGHED_GA_MAX
    for g in gas:
        if g <= UNWEIGHED_GA_MAX:
            weights.append(None)
            continue
        rate = rng.uniform(0.05, 0.18) if low_gain else rng.uniform(0.35, 0.50)
        raw += rate * (g - prev_ga) / 7.0
        prev_ga = g
        weights.append(round(raw, 1))

    visits_tmp = [
        triage.VisitFacts(
            id=str(i),
            visit_date=lmp + timedelta(days=g),
            client_created_at=ist_at(lmp + timedelta(days=g), 10),
            weight_kg=w,
            hb_gdl=None,
            bp_systolic=None,
            bp_diastolic=None,
        )
        for i, (g, w) in enumerate(zip(gas, weights))
    ]
    weighed = [v for v in visits_tmp if v.weight_kg is not None]
    if profile.key == "WEIGHT_STATIC":
        if not weighed:
            return None
        ref = triage.select_reference_visit(
            weighed,
            weighed[-1],
            triage.THRESHOLDS["static_min_interval_days"],
            min_ga_days=triage.THRESHOLDS["static_min_ga_days"],
            lmp=lmp,
        )
        if ref is None:
            return None
        start = int(ref.id)
        flat = weights[start]
        weights = [flat if (i >= start and w is not None) else w for i, w in enumerate(weights)]
    elif profile.key == "WEIGHT_LOSS":
        if not weighed:
            return None
        ref = triage.select_reference_visit(
            weighed, weighed[-1], triage.THRESHOLDS["loss_min_interval_days"]
        )
        if ref is None:
            return None
        last_idx = int(weighed[-1].id)
        weights[last_idx] = round(ref.weight_kg - rng.uniform(1.3, 2.0), 1)

    visits: List[PlannedVisit] = []
    last = len(gas) - 1
    for i, (g, w) in enumerate(zip(gas, weights)):
        hb = _green_hb(rng)
        sys_, dia = _green_bp(rng)
        if i == last:
            if profile.code == "HB_SEVERE":
                hb = round(rng.uniform(5.8, 6.9), 1)
            elif profile.key == "HB_MODERATE":
                hb = round(rng.uniform(7.5, 9.6), 1)
            elif profile.key == "HB_MILD":
                hb = round(rng.uniform(10.1, 10.8), 1)
            elif profile.code == "BP_SEVERE":
                sys_, dia = rng.randint(162, 175), rng.randint(100, 108)
            elif profile.key == "BP_HIGH":
                sys_, dia = rng.randint(142, 155), rng.randint(88, 98)
        tablets = g > IFA_FROM_GA
        visits.append(
            PlannedVisit(
                visit_date=lmp + timedelta(days=g),
                weight_kg=w,
                hb_gdl=hb,
                bp_systolic=sys_,
                bp_diastolic=dia,
                ifa_tablets=30 if tablets else 0,
                calcium_tablets=60 if tablets else 0,
                thr_received=True if is_bpl else rng.random() < 0.7,
            )
        )

    followup: Optional[PlannedVisit] = None
    if profile.loop == "done":
        task_day = loop_task_day(profile, seed_day)
        fday = task_day + timedelta(days=rng.randint(*FOLLOWUP_AFTER_TASK_DAYS))
        sys_, dia = _green_bp(rng)
        followup = PlannedVisit(
            visit_date=fday,
            weight_kg=None,
            hb_gdl=round(rng.uniform(*FOLLOWUP_HB), 1),
            bp_systolic=sys_,
            bp_diastolic=dia,
            ifa_tablets=30,
            calcium_tablets=60,
            thr_received=True if is_bpl else rng.random() < 0.7,
        )

    return VisitPlan(
        profile=profile.key,
        ga_days=ga,
        lmp_date=lmp,
        height_cm=height,
        first_weight_kg=first_weight,
        visits=tuple(visits),
        followup=followup,
    )


def _facts(plan: VisitPlan, visits: Sequence[PlannedVisit]):
    m = triage.MotherFacts(
        lmp_date=plan.lmp_date,
        registered_on=plan.registered_on,
        height_cm=plan.height_cm,
        first_weight_kg=plan.first_weight_kg,
        status=MotherStatus.active.value,
    )
    vf = [
        triage.VisitFacts(
            id=f"plan-{i}",
            visit_date=v.visit_date,
            client_created_at=v.client_created_at,
            weight_kg=v.weight_kg,
            hb_gdl=v.hb_gdl,
            bp_systolic=v.bp_systolic,
            bp_diastolic=v.bp_diastolic,
        )
        for i, v in enumerate(visits)
    ]
    return m, vf


def plan_codes(plan: VisitPlan, today: date, *, include_followup: bool = True) -> FrozenSet[str]:
    visits = list(plan.visits)
    if include_followup and plan.followup is not None:
        visits.append(plan.followup)
    m, vf = _facts(plan, visits)
    return frozenset(r.code for r in triage.evaluate(m, vf, today))


def _codes_match(codes: FrozenSet[str], required: FrozenSet[str], extra: FrozenSet[str]) -> bool:
    return required <= codes <= (required | extra)


def verify_plan(plan: VisitPlan, profile: Profile, seed_day: date) -> bool:
    """Generate-and-verify: the pure triage of the plan on the seed day yields the
    profile's intended codes; closed-loop plans also yield the RED code on the task
    day before the follow-up visit."""
    if not _codes_match(plan_codes(plan, seed_day), profile.intended_codes, profile.allowed_extra):
        return False
    if profile.loop is not None:
        task_day = loop_task_day(profile, seed_day)
        if any(v.visit_date >= task_day for v in plan.visits):
            return False
        if plan_codes(plan, task_day, include_followup=False) != profile.phase_a_codes:
            return False
    return True


# --------------------------------------------------------------------------- full plan


@dataclass
class MotherPlan:
    id: str
    full_name: str
    guardian_name: str
    age: int
    village: str
    is_bpl: bool
    plan: VisitPlan
    visit_ids: List[str]
    followup_id: Optional[str] = None
    task_id: Optional[str] = None


@dataclass
class DeliveredPlan:
    id: str
    full_name: str
    guardian_name: str
    age: int
    village: str
    lmp_date: date
    height_cm: float
    first_weight_kg: float
    visits: List[PlannedVisit]
    visit_ids: List[str]
    delivery_date: date
    birth_weight_kg: float
    outcome_id: str


@dataclass
class SeedPlan:
    facility_id: str
    village_ids: Dict[str, str]
    user_ids: Dict[str, str]
    mothers: List[MotherPlan]
    delivered: List[DeliveredPlan]


def _names(rng: random.Random) -> Tuple[str, str, int]:
    return (
        f"{rng.choice(FIRST_NAMES)} {NAME_TAG}",
        f"{rng.choice(GUARDIAN_NAMES)} {NAME_TAG}",
        rng.randint(18, 38),
    )


def _plan_mother(
    rng: random.Random, remaining: Dict[str, int], seed_day: date, is_bpl: bool
) -> VisitPlan:
    for _attempt in range(MAX_ATTEMPTS):
        ga = rng.randint(GA_MIN_DAYS, GA_MAX_DAYS)
        options = eligible_profiles(remaining, ga)
        if not options:
            continue
        profile = PROFILES[rng.choice(options)]
        plan = plan_visits(rng, ga, profile, seed_day, is_bpl=is_bpl)
        if plan is not None and verify_plan(plan, profile, seed_day):
            remaining[profile.key] -= 1
            return plan
    left = sorted(k for k, v in remaining.items() if v)
    raise SeedPlanError(f"no feasible plan after {MAX_ATTEMPTS} attempts (remaining: {left})")


def _plan_delivered(rng: random.Random, seed_day: date, village: str, lbw: bool) -> DeliveredPlan:
    mid = new_id(rng)
    full_name, guardian, age = _names(rng)
    delivery = seed_day - timedelta(days=rng.randint(5, 60))
    delivery_ga = rng.randint(266, 287)
    lmp = delivery - timedelta(days=delivery_ga)
    height = float(rng.randint(145, 165))
    first_weight = round(rng.uniform(19.5, 25.0) * (height / 100.0) ** 2, 1)
    gas = [rng.randint(56, 84), rng.randint(150, 180), delivery_ga - rng.randint(7, 20)]
    visits: List[PlannedVisit] = []
    raw = first_weight + 0.15 * UNWEIGHED_GA_MAX / 7.0
    prev = UNWEIGHED_GA_MAX
    for g in gas:
        weight: Optional[float] = None
        if g > UNWEIGHED_GA_MAX:
            raw += rng.uniform(0.35, 0.50) * (g - prev) / 7.0
            prev = g
            weight = round(raw, 1)
        sys_, dia = _green_bp(rng)
        visits.append(
            PlannedVisit(
                visit_date=lmp + timedelta(days=g),
                weight_kg=weight,
                hb_gdl=_green_hb(rng),
                bp_systolic=sys_,
                bp_diastolic=dia,
                ifa_tablets=30 if g > IFA_FROM_GA else 0,
                calcium_tablets=60 if g > IFA_FROM_GA else 0,
                thr_received=rng.random() < 0.7,
            )
        )
    visit_ids = [new_id(rng) for _ in visits]
    birth_weight = round(rng.uniform(2.1, 2.4) if lbw else rng.uniform(2.6, 3.4), 2)
    return DeliveredPlan(
        id=mid,
        full_name=full_name,
        guardian_name=guardian,
        age=age,
        village=village,
        lmp_date=lmp,
        height_cm=height,
        first_weight_kg=first_weight,
        visits=visits,
        visit_ids=visit_ids,
        delivery_date=delivery,
        birth_weight_kg=birth_weight,
        outcome_id=new_id(rng),
    )


def build_plan(seed_day: date) -> SeedPlan:
    """Everything random, in a fixed rng order, before any database write."""
    rng = random.Random(RNG_SEED)
    facility_id = new_id(rng)
    village_ids = {name: new_id(rng) for name, _, _ in VILLAGES}
    user_ids = {username: new_id(rng) for username, *_ in USERS}

    generated = ACTIVE_MOTHERS - 1
    bpl = set(rng.sample(range(generated), BPL_COUNT))
    slots = [name for name, _, _ in VILLAGES for _ in range(MOTHERS_PER_VILLAGE)]
    slots.remove(demo_data.DEMO_VILLAGE_NAME)  # the demo mother takes one Dankaur slot
    rng.shuffle(slots)

    remaining = dict(PROFILE_COUNTS)
    mothers: List[MotherPlan] = []
    for i in range(generated):
        mid = new_id(rng)
        full_name, guardian, age = _names(rng)
        plan = _plan_mother(rng, remaining, seed_day, i in bpl)
        visit_ids = [new_id(rng) for _ in plan.visits]
        mothers.append(
            MotherPlan(
                id=mid,
                full_name=full_name,
                guardian_name=guardian,
                age=age,
                village=slots[i],
                is_bpl=i in bpl,
                plan=plan,
                visit_ids=visit_ids,
                followup_id=new_id(rng) if plan.followup is not None else None,
                task_id=new_id(rng) if PROFILES[plan.profile].loop else None,
            )
        )
    assert not any(remaining.values()), remaining

    lbw_idx = set(rng.sample(range(DELIVERED_MOTHERS), LBW_BIRTHS))
    village_names = [name for name, _, _ in VILLAGES]
    delivered = [
        _plan_delivered(rng, seed_day, village_names[i % len(village_names)], i in lbw_idx)
        for i in range(DELIVERED_MOTHERS)
    ]
    return SeedPlan(facility_id, village_ids, user_ids, mothers, delivered)


# --------------------------------------------------------------------------- writing


@dataclass
class SeedReport:
    seed_day: date
    total_active: int
    red: int
    amber: int
    green: int
    bpl: int
    delivered: int
    lbw: int
    per_village: Dict[str, Dict[str, int]] = field(default_factory=dict)
    mother_ids: List[str] = field(default_factory=list)

    def lines(self) -> List[str]:
        out = [
            f"Seeded {self.total_active} active mothers (+{self.delivered} delivered, "
            f"{self.lbw} LBW) for seed day {self.seed_day.isoformat()}",
            f"RED {self.red}  AMBER {self.amber}  GREEN {self.green}  BPL {self.bpl}",
        ]
        for name, c in self.per_village.items():
            out.append(
                f"  {name:<13} pregnant {c['total']:>3}  RED {c['RED']:>2}  "
                f"AMBER {c['AMBER']:>2}  GREEN {c['GREEN']:>2}  BPL {c['bpl']:>2}"
            )
        return out


def _village_asha(user_ids: Dict[str, str]) -> Dict[str, str]:
    return {v: user_ids[username] for username, _, role, villages, _ in USERS for v in villages}


def _visit_row(
    vid: str, mother_id: str, v: PlannedVisit, recorded_by: str, seq: int, device_id: str = "seed"
) -> Visit:
    return Visit(
        id=vid,
        mother_id=mother_id,
        visit_date=v.visit_date,
        weight_kg=v.weight_kg,
        weight_source="manual" if v.weight_kg is not None else None,
        hb_gdl=v.hb_gdl,
        hb_source="manual",
        bp_systolic=v.bp_systolic,
        bp_diastolic=v.bp_diastolic,
        bp_source="manual",
        ifa_tablets=v.ifa_tablets,
        calcium_tablets=v.calcium_tablets,
        thr_received=v.thr_received,
        recorded_by_id=recorded_by,
        device_id=device_id,
        client_created_at=v.client_created_at,
        received_at=ist_at(v.visit_date, 18),
        change_seq=seq,
    )


def _write_base(session: Session, plan: SeedPlan, now: datetime) -> None:
    db.begin_write(session)
    session.add(Facility(id=plan.facility_id, **FACILITY))
    for name, lat, lng in VILLAGES:
        session.add(
            Village(id=plan.village_ids[name], name=name, facility_id=plan.facility_id, lat=lat, lng=lng)
        )
    for username, full_name, role, villages, phone in USERS:
        session.add(
            User(
                id=plan.user_ids[username],
                username=username,
                password_hash=hash_password(DEMO_PASSWORD),
                full_name=full_name,
                role=role,
                facility_id=None if role == Role.admin.value else plan.facility_id,
                phone=phone,
                created_at=now,
            )
        )
        for v in villages:
            session.add(UserVillage(user_id=plan.user_ids[username], village_id=plan.village_ids[v]))
    session.flush()
    assert_user_villages_in_facility(session)
    session.commit()


def assert_user_villages_in_facility(session: Session) -> None:
    """Req 6.6: every UserVillage row's village belongs to the user's facility."""
    bad = session.execute(
        select(UserVillage.user_id, UserVillage.village_id)
        .join(User, User.id == UserVillage.user_id)
        .join(Village, Village.id == UserVillage.village_id)
        .where((User.facility_id.is_(None)) | (User.facility_id != Village.facility_id))
    ).all()
    if bad:
        raise AssertionError(f"user-village pairs outside the user's facility: {bad}")


def _write_mothers(session: Session, plan: SeedPlan, seed_day: date) -> None:
    seq = db.begin_write(session)
    asha_of = _village_asha(plan.user_ids)

    # Demo mother.
    hist = demo_data.build_demo_mother_history(seed_day)
    demo_asha = plan.user_ids[demo_data.DEMO_ASHA_USERNAME]
    session.add(
        Mother(
            id=demo_data.DEMO_MOTHER_ID,
            full_name=demo_data.DEMO_MOTHER_NAME,
            age=demo_data.DEMO_MOTHER_AGE,
            guardian_name=demo_data.DEMO_GUARDIAN_NAME,
            village_id=plan.village_ids[demo_data.DEMO_VILLAGE_NAME],
            facility_id=plan.facility_id,
            asha_id=demo_asha,
            phone=None,
            lmp_date=hist.lmp_date,
            edd_date=edd_naegele(hist.lmp_date),
            is_bpl=False,
            height_cm=hist.height_cm,
            first_weight_kg=hist.first_weight_kg,
            registered_at=hist.registered_at,
            status=MotherStatus.active.value,
            risk_level=RiskLevel.GREEN.value,
            created_at=hist.registered_at,
            updated_at=hist.registered_at,
            change_seq=seq,
        )
    )
    for dv in hist.visits:
        session.add(
            Visit(
                id=dv.id,
                mother_id=demo_data.DEMO_MOTHER_ID,
                visit_date=dv.visit_date,
                weight_kg=dv.weight_kg,
                weight_source=dv.weight_source,
                hb_gdl=dv.hb_gdl,
                hb_source="manual",
                bp_systolic=dv.bp_systolic,
                bp_diastolic=dv.bp_diastolic,
                bp_source="manual",
                ifa_tablets=dv.ifa_tablets,
                calcium_tablets=dv.calcium_tablets,
                thr_received=True,
                recorded_by_id=demo_asha,
                device_id=demo_data.DEMO_SEED_DEVICE_ID,
                client_created_at=dv.client_created_at,
                received_at=ist_at(dv.visit_date, 18),
                change_seq=seq,
            )
        )

    def add_mother(mid, full_name, guardian, age, village, is_bpl, lmp, height, first_w, reg_at):
        session.add(
            Mother(
                id=mid,
                full_name=full_name,
                age=age,
                guardian_name=guardian,
                village_id=plan.village_ids[village],
                facility_id=plan.facility_id,
                asha_id=asha_of[village],
                phone=None,
                lmp_date=lmp,
                edd_date=edd_naegele(lmp),
                is_bpl=is_bpl,
                height_cm=height,
                first_weight_kg=first_w,
                registered_at=reg_at,
                status=MotherStatus.active.value,
                risk_level=RiskLevel.GREEN.value,
                created_at=reg_at,
                updated_at=reg_at,
                change_seq=seq,
            )
        )

    for mp in plan.mothers:
        p = mp.plan
        add_mother(
            mp.id, mp.full_name, mp.guardian_name, mp.age, mp.village, mp.is_bpl,
            p.lmp_date, p.height_cm, p.first_weight_kg, p.registered_at,
        )
        for vid, v in zip(mp.visit_ids, p.visits):
            session.add(_visit_row(vid, mp.id, v, asha_of[mp.village], seq))

    for dp in plan.delivered:
        add_mother(
            dp.id, dp.full_name, dp.guardian_name, dp.age, dp.village, False,
            dp.lmp_date, dp.height_cm, dp.first_weight_kg, ist_at(dp.visits[0].visit_date, 9),
        )
        for vid, v in zip(dp.visit_ids, dp.visits):
            session.add(_visit_row(vid, dp.id, v, asha_of[dp.village], seq))
    session.commit()


def _write_closed_loops(session: Session, plan: SeedPlan, seed_day: date) -> None:
    """6 RED mothers: RED alert on the task day (06:00 IST), task at 12:00 IST via
    ``task_service.create_task``; the 2 ``done`` ones get a later Hb follow-up visit
    and complete the task through the sync completion handler."""
    doctor = load_current_user(session, plan.user_ids["doctor1"])
    session.rollback()
    asha_of = _village_asha(plan.user_ids)
    loops = [mp for mp in plan.mothers if PROFILES[mp.plan.profile].loop]
    loops.sort(key=lambda mp: (loop_task_day(PROFILES[mp.plan.profile], seed_day), mp.id))

    for mp in loops:
        profile = PROFILES[mp.plan.profile]
        task_day = loop_task_day(profile, seed_day)
        outcome = apply_triage(session, mp.id, ist_at(task_day, 6))
        alert = session.execute(
            select(Alert).where(
                Alert.mother_id == mp.id,
                Alert.severity == AlertSeverity.RED.value,
                Alert.status == AlertStatus.open.value,
            )
        ).scalar_one_or_none()
        session.rollback()
        if outcome.risk_level != RiskLevel.RED.value or alert is None:
            raise SeedPlanError(f"closed-loop mother {mp.id} did not raise a RED alert")

        data = TaskCreateIn(
            action_type=LOOP_ACTION[profile.loop],
            instructions=None,
            due_date=task_day + timedelta(days=LOOP_DUE_AFTER_DAYS[profile.loop]),
        )
        task_service.create_task(
            session, doctor, mp.id, data, ist_at(task_day, 12), task_id=mp.task_id
        )

        if profile.loop != "done":
            continue
        fv = mp.plan.followup
        assert fv is not None and mp.followup_id is not None
        seq = db.begin_write(session)
        session.add(_visit_row(mp.followup_id, mp.id, fv, asha_of[mp.village], seq))
        session.commit()

        done_now = ist_at(fv.visit_date, 11)
        asha = load_current_user(session, asha_of[mp.village])
        session.rollback()
        complete = TaskCompleteIn.model_validate(
            {"id": mp.task_id, "done_at": done_now.isoformat() + "Z", "done_note": LOOP_DONE_NOTE},
            context={"now": done_now},
        )
        seq = db.begin_write(session)
        result = apply_task_complete(session, asha, "seed", complete, seq, done_now)
        if result.result.status != "applied":
            session.rollback()
            raise SeedPlanError(f"closed-loop task {mp.task_id} not completed")
        session.commit()
        apply_triage(session, mp.id, done_now)  # as after a push


def _write_outcomes(session: Session, plan: SeedPlan) -> None:
    doctor = load_current_user(session, plan.user_ids["doctor1"])
    session.rollback()
    for dp in plan.delivered:
        data = BirthOutcomeIn(
            delivery_date=dp.delivery_date, outcome="live_birth", birth_weight_kg=dp.birth_weight_kg
        )
        outcome_service.record(
            session,
            doctor,
            dp.id,
            data,
            ist_at(dp.delivery_date + timedelta(days=1), 12),
            outcome_id=dp.outcome_id,
        )


def build_report(session: Session, seed_day: date) -> SeedReport:
    mothers = session.execute(select(Mother).order_by(Mother.id)).scalars().all()
    villages = session.execute(select(Village)).scalars().all()
    vname = {v.id: v.name for v in villages}
    active = [m for m in mothers if m.status == MotherStatus.active.value]
    levels = Counter(m.risk_level for m in active)
    per_village: Dict[str, Dict[str, int]] = {}
    for name, _, _ in VILLAGES:
        per_village[name] = {"total": 0, "RED": 0, "AMBER": 0, "GREEN": 0, "bpl": 0}
    for m in active:
        c = per_village[vname[m.village_id]]
        c["total"] += 1
        c[m.risk_level] += 1
        c["bpl"] += int(m.is_bpl)
    lbw = session.execute(
        select(func.count()).select_from(BirthOutcome).where(BirthOutcome.is_lbw.is_(True))
    ).scalar_one()
    session.rollback()
    return SeedReport(
        seed_day=seed_day,
        total_active=len(active),
        red=levels.get(RiskLevel.RED.value, 0),
        amber=levels.get(RiskLevel.AMBER.value, 0),
        green=levels.get(RiskLevel.GREEN.value, 0),
        bpl=sum(1 for m in active if m.is_bpl),
        delivered=sum(1 for m in mothers if m.status == MotherStatus.delivered.value),
        lbw=int(lbw),
        per_village=per_village,
        mother_ids=[m.id for m in mothers],
    )


def seed(session_factory: Callable[[], Session], seed_day: date) -> SeedReport:
    """Write the whole synthetic dataset into an empty database and triage it."""
    plan = build_plan(seed_day)
    now_seed = ist_at(seed_day, 6)
    with session_factory() as session:
        _write_base(session, plan, now_seed)
        _write_mothers(session, plan, seed_day)
        _write_closed_loops(session, plan, seed_day)
        _write_outcomes(session, plan)

        ids = session.execute(select(Mother.id).order_by(Mother.id)).scalars().all()
        session.rollback()
        for mid in ids:  # final triage for every mother (Req 39.13)
            apply_triage(session, mid, now_seed)
        return build_report(session, seed_day)


# --------------------------------------------------------------------------- CLI


def has_data(session: Session) -> bool:
    found = session.execute(select(Facility.id).limit(1)).first() is not None
    session.rollback()
    return found


def reset_database() -> None:
    """Drop and recreate every table; ``init_db`` inserts a new SyncCounter epoch."""
    db._ensure_configured()  # noqa: SLF001
    from app import models  # noqa: F401  (registers every table)

    db.Base.metadata.drop_all(bind=db.engine)
    db.init_db()


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.seed", description=__doc__.splitlines()[0])
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--reset", action="store_true", help="drop and recreate all tables, then seed")
    group.add_argument("--if-empty", action="store_true", help="seed only when no facility exists")
    args = parser.parse_args(list(argv) if argv is not None else None)

    if not logging.getLogger().handlers:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    settings = get_settings()
    seed_day = settings.seed_today or today_ist()

    try:
        if args.reset:
            reset_database()
        else:
            db.init_db()
            with db.SessionLocal() as session:
                if has_data(session):
                    if args.if_empty:
                        print("Database already seeded; nothing to do (--if-empty).")
                        return 0
                    print(
                        "Database already contains data. Use --reset to recreate it "
                        "or --if-empty to skip.",
                        file=sys.stderr,
                    )
                    return 1
        report = seed(db.SessionLocal, seed_day)
    except SeedPlanError as exc:
        log.error("seed failed: %s", exc)
        return 1

    for line in report.lines():
        print(line)
    return 0


__all__ = [
    "RNG_SEED",
    "DEMO_PASSWORD",
    "SeedPlanError",
    "Profile",
    "PROFILES",
    "PROFILE_COUNTS",
    "PlannedVisit",
    "VisitPlan",
    "SeedPlan",
    "SeedReport",
    "new_id",
    "visit_count",
    "eligible_profiles",
    "plan_visits",
    "plan_codes",
    "verify_plan",
    "build_plan",
    "seed",
    "assert_user_villages_in_facility",
    "reset_database",
    "main",
]


if __name__ == "__main__":
    sys.exit(main())
