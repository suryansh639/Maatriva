"""Pure triage rule engine for Maatriva.

Demo thresholds based on WHO/MoHFW Anemia Mukt Bharat guidance; must be validated by a clinician before real use.

Hb 10.0–10.9 g/dL is classified AMBER (``HB_MILD``), not GREEN with a note.
WHO defines anaemia in pregnancy as Hb < 11.0 g/dL, with 10.0–10.9 as mild,
and Anemia Mukt Bharat treats anaemia in pregnancy (including mild) with
therapeutic IFA rather than routine prophylaxis, so this band needs a
follow-up action. AMBER routes it to the ANM digest without paging the
doctor, which keeps the doctor in the loop for RED cases only.

This module performs no database access and no I/O. It takes plain
``MotherFacts`` and ``VisitFacts`` objects plus a "today" date and returns
``RuleResult`` items in a fixed rule order. All visit lists are sorted by
``(visit_date, client_created_at)``; that is the single tie-break used by
every rule.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Iterable, List, Optional, Sequence

from app.gestation import ga_days

THRESHOLDS = {
    "hb_severe_lt": 7.0,  # RED
    "hb_moderate_lt": 10.0,  # AMBER
    "hb_mild_lt": 11.0,  # AMBER (see module docstring for the rationale)
    "bp_red_sys_gte": 160,
    "bp_red_dia_gte": 110,
    "bp_amber_sys_gte": 140,
    "bp_amber_dia_gte": 90,
    "gain_check_after_ga_days": 91,  # > 13 weeks
    "gain_min_kg_per_week": 0.25,
    "gain_min_interval_days": 14,
    "loss_check_after_ga_days": 140,  # > 20 weeks
    "loss_kg_gt": 1.0,
    "loss_min_interval_days": 28,
    "static_min_ga_days": 98,  # 2nd/3rd trimester (>= 14w0d)
    "static_min_interval_days": 42,
    "static_max_gain_kg": 0.0,
    "bmi_low_lt": 18.5,
    "late_registration_ga_days_gt": 84,  # registered after 12w0d
    "overdue_visit_days_gt": 35,
}

SEVERITY_RANK = {"GREEN": 0, "AMBER": 1, "RED": 2}

# English reason templates (the field app shows a translated flag label next
# to these server reasons).
REASONS = {
    "HB_SEVERE": "Hb {hb} g/dL (<7.0): severe anaemia",
    "HB_MODERATE": "Hb {hb} g/dL (7.0–9.9): moderate anaemia",
    "HB_MILD": "Hb {hb} g/dL (10.0–10.9): mild anaemia, needs treatment follow-up",
    "BP_SEVERE": "BP {s}/{d} (≥160/110): severe hypertension",
    "BP_HIGH": "BP {s}/{d} (≥140/90): high blood pressure",
    "WEIGHT_LOSS": "Weight down {x} kg in {n} weeks after 20 weeks",
    "WEIGHT_STATIC": "No weight gain in {n} weeks (2nd/3rd trimester)",
    "WEIGHT_GAIN_LOW": "Weight gain {r} kg/week (<0.25) over {n} weeks",
    "BMI_LOW": "BMI {bmi} at registration (<18.5)",
    "LATE_REG": "Registered late at {w} weeks (>12)",
    "VISIT_OVERDUE": "No visit for {n} days (>35)",
}

# Comparisons on derived floats (differences, rates, BMI) are rounded first so
# binary floating-point noise never flips a boundary (e.g. 57.1 - 56.1).
_WEIGHT_DP = 2
_RATIO_DP = 9


@dataclass(frozen=True)
class MotherFacts:
    lmp_date: date
    registered_on: date
    height_cm: Optional[float]
    first_weight_kg: Optional[float]
    status: str


@dataclass(frozen=True)
class VisitFacts:
    id: str
    visit_date: date
    client_created_at: datetime
    weight_kg: Optional[float]
    hb_gdl: Optional[float]
    bp_systolic: Optional[int]
    bp_diastolic: Optional[int]


@dataclass(frozen=True)
class RuleResult:
    code: str
    severity: str  # "RED" | "AMBER"
    reason: str
    source_visit_id: Optional[str]


def _sort_key(v: VisitFacts):
    return (v.visit_date, v.client_created_at or datetime.min)


def _sorted(visits: Iterable[VisitFacts]) -> List[VisitFacts]:
    return sorted(visits, key=_sort_key)


def select_reference_visit(
    weighed: Sequence[VisitFacts],
    latest: VisitFacts,
    min_gap_days: int,
    min_ga_days: Optional[int] = None,
    lmp: Optional[date] = None,
) -> Optional[VisitFacts]:
    """Return the most recent weighed visit before ``latest`` (in sort order)
    that is at least ``min_gap_days`` before it and, when ``min_ga_days`` is
    given, at a GA of at least ``min_ga_days`` (requires ``lmp``).
    """
    ordered = _sorted(weighed)
    idx = next((i for i, v in enumerate(ordered) if v is latest), None)
    if idx is None:
        key = _sort_key(latest)
        candidates = [v for v in ordered if _sort_key(v) < key]
    else:
        candidates = ordered[:idx]
    for p in reversed(candidates):
        if p.weight_kg is None:
            continue
        if (latest.visit_date - p.visit_date).days < min_gap_days:
            continue
        if min_ga_days is not None:
            if lmp is None:
                raise ValueError("lmp is required with min_ga_days")
            if ga_days(lmp, p.visit_date) < min_ga_days:
                continue
        return p
    return None


def worst(results: Iterable) -> str:
    """Worst severity of the results: RED > AMBER > GREEN; empty -> GREEN.

    Accepts objects with a ``severity`` attribute or plain severity strings.
    """
    level = "GREEN"
    for r in results:
        sev = getattr(r, "severity", r)
        if SEVERITY_RANK.get(sev, 0) > SEVERITY_RANK[level]:
            level = sev
    return level


# ---------------------------------------------------------------- rules


def _hb_rules(ordered: List[VisitFacts]) -> List[RuleResult]:
    latest = next((v for v in reversed(ordered) if v.hb_gdl is not None), None)
    if latest is None:
        return []
    hb = latest.hb_gdl
    text = f"{hb:.1f}"
    if hb < THRESHOLDS["hb_severe_lt"]:
        code, sev = "HB_SEVERE", "RED"
    elif hb < THRESHOLDS["hb_moderate_lt"]:
        code, sev = "HB_MODERATE", "AMBER"
    elif hb < THRESHOLDS["hb_mild_lt"]:
        code, sev = "HB_MILD", "AMBER"
    else:
        return []
    return [RuleResult(code, sev, REASONS[code].format(hb=text), latest.id)]


def _bp_rules(ordered: List[VisitFacts]) -> List[RuleResult]:
    latest = next(
        (
            v
            for v in reversed(ordered)
            if v.bp_systolic is not None and v.bp_diastolic is not None
        ),
        None,
    )
    if latest is None:
        return []
    s, d = int(latest.bp_systolic), int(latest.bp_diastolic)
    if s >= THRESHOLDS["bp_red_sys_gte"] or d >= THRESHOLDS["bp_red_dia_gte"]:
        code, sev = "BP_SEVERE", "RED"
    elif s >= THRESHOLDS["bp_amber_sys_gte"] or d >= THRESHOLDS["bp_amber_dia_gte"]:
        code, sev = "BP_HIGH", "AMBER"
    else:
        return []
    return [RuleResult(code, sev, REASONS[code].format(s=s, d=d), latest.id)]


def _weight_rules(m: MotherFacts, ordered: List[VisitFacts]) -> List[RuleResult]:
    weighed = [v for v in ordered if v.weight_kg is not None]
    if len(weighed) < 2:
        return []
    last = weighed[-1]
    ga_last = ga_days(m.lmp_date, last.visit_date)
    out: List[RuleResult] = []

    # WEIGHT_LOSS (RED)
    if ga_last > THRESHOLDS["loss_check_after_ga_days"]:
        p = select_reference_visit(weighed, last, THRESHOLDS["loss_min_interval_days"])
        if p is not None:
            loss = round(p.weight_kg - last.weight_kg, _WEIGHT_DP)
            if loss > THRESHOLDS["loss_kg_gt"]:
                weeks = (last.visit_date - p.visit_date).days // 7
                out.append(
                    RuleResult(
                        "WEIGHT_LOSS",
                        "RED",
                        REASONS["WEIGHT_LOSS"].format(x=f"{loss:.1f}", n=weeks),
                        last.id,
                    )
                )

    # WEIGHT_STATIC (RED)
    if ga_last >= THRESHOLDS["static_min_ga_days"]:
        p = select_reference_visit(
            weighed,
            last,
            THRESHOLDS["static_min_interval_days"],
            min_ga_days=THRESHOLDS["static_min_ga_days"],
            lmp=m.lmp_date,
        )
        if p is not None:
            gain = round(last.weight_kg - p.weight_kg, 1)
            if gain <= THRESHOLDS["static_max_gain_kg"]:
                weeks = (last.visit_date - p.visit_date).days // 7
                out.append(
                    RuleResult(
                        "WEIGHT_STATIC",
                        "RED",
                        REASONS["WEIGHT_STATIC"].format(n=weeks),
                        last.id,
                    )
                )

    # WEIGHT_GAIN_LOW (AMBER), suppressed by WEIGHT_LOSS or WEIGHT_STATIC
    if not out and ga_last > THRESHOLDS["gain_check_after_ga_days"]:
        p = select_reference_visit(weighed, last, THRESHOLDS["gain_min_interval_days"])
        if p is not None:
            days = (last.visit_date - p.visit_date).days
            diff = round(last.weight_kg - p.weight_kg, _WEIGHT_DP)
            rate = round(diff / (days / 7), _RATIO_DP)
            if rate < THRESHOLDS["gain_min_kg_per_week"]:
                out.append(
                    RuleResult(
                        "WEIGHT_GAIN_LOW",
                        "AMBER",
                        REASONS["WEIGHT_GAIN_LOW"].format(r=f"{rate:.2f}", n=days // 7),
                        last.id,
                    )
                )
    return out


def _bmi_rule(m: MotherFacts, ordered: List[VisitFacts]) -> List[RuleResult]:
    if m.height_cm is None or m.height_cm <= 0:
        return []
    source_id: Optional[str] = None
    if m.first_weight_kg is not None:
        baseline = m.first_weight_kg
    else:
        first = next((v for v in ordered if v.weight_kg is not None), None)
        if first is None:
            return []
        baseline = first.weight_kg
        source_id = first.id
    h_m = m.height_cm / 100.0
    bmi = round(baseline / (h_m * h_m), _RATIO_DP)
    if bmi < THRESHOLDS["bmi_low_lt"]:
        return [
            RuleResult("BMI_LOW", "AMBER", REASONS["BMI_LOW"].format(bmi=f"{bmi:.1f}"), source_id)
        ]
    return []


def _late_reg_rule(m: MotherFacts) -> List[RuleResult]:
    ga_reg = ga_days(m.lmp_date, m.registered_on)
    if ga_reg > THRESHOLDS["late_registration_ga_days_gt"]:
        return [
            RuleResult("LATE_REG", "AMBER", REASONS["LATE_REG"].format(w=ga_reg // 7), None)
        ]
    return []


def _overdue_rule(m: MotherFacts, ordered: List[VisitFacts], today: date) -> List[RuleResult]:
    if ordered:
        last = ordered[-1]
        ref, source_id = last.visit_date, last.id
    else:
        ref, source_id = m.registered_on, None
    gap = (today - ref).days
    if gap > THRESHOLDS["overdue_visit_days_gt"]:
        return [
            RuleResult("VISIT_OVERDUE", "AMBER", REASONS["VISIT_OVERDUE"].format(n=gap), source_id)
        ]
    return []


def evaluate(m: MotherFacts, visits: Sequence[VisitFacts], today: date) -> List[RuleResult]:
    """Evaluate all rules for one mother. Delivered mothers yield ``[]``.

    Output order follows the rule table: HB_*, BP_*, WEIGHT_LOSS,
    WEIGHT_STATIC, WEIGHT_GAIN_LOW, BMI_LOW, LATE_REG, VISIT_OVERDUE.
    """
    if m.status == "delivered":
        return []
    ordered = _sorted(visits)
    results: List[RuleResult] = []
    results.extend(_hb_rules(ordered))
    results.extend(_bp_rules(ordered))
    results.extend(_weight_rules(m, ordered))
    results.extend(_bmi_rule(m, ordered))
    results.extend(_late_reg_rule(m))
    results.extend(_overdue_rule(m, ordered, today))
    return results
