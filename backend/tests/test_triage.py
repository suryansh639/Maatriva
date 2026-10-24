"""Triage rule engine unit tests (Requirements 13.2–13.8, 14.2–14.9, 40.5, 44.1).

Pure tests: no database. Every case is built from plain ``MotherFacts`` and
``VisitFacts`` with dates expressed as gestational age (days from LMP), and
each rule is checked at and around its threshold.
"""
from __future__ import annotations

import itertools
from datetime import date, datetime, time, timedelta
from typing import List, Optional

import pytest

from app.triage import (
    REASONS,
    RuleResult,
    MotherFacts,
    VisitFacts,
    evaluate,
    worst,
)

LMP = date(2024, 1, 1)
_ids = itertools.count(1)


def on_ga(ga: int) -> date:
    return LMP + timedelta(days=ga)


def mother(
    *,
    reg_ga: int = 60,
    height_cm: Optional[float] = None,
    first_weight_kg: Optional[float] = None,
    status: str = "active",
) -> MotherFacts:
    """Defaults never trigger BMI_LOW (no height) or LATE_REG (GA 60)."""
    return MotherFacts(
        lmp_date=LMP,
        registered_on=on_ga(reg_ga),
        height_cm=height_cm,
        first_weight_kg=first_weight_kg,
        status=status,
    )


def visit(
    ga: int,
    *,
    weight: Optional[float] = None,
    hb: Optional[float] = None,
    bp: Optional[tuple] = None,
    created: Optional[datetime] = None,
    vid: Optional[str] = None,
) -> VisitFacts:
    d = on_ga(ga)
    return VisitFacts(
        id=vid or f"v{next(_ids)}",
        visit_date=d,
        client_created_at=created or datetime.combine(d, time(10, 0)),
        weight_kg=weight,
        hb_gdl=hb,
        bp_systolic=bp[0] if bp else None,
        bp_diastolic=bp[1] if bp else None,
    )


def run(visits: List[VisitFacts], m: Optional[MotherFacts] = None, today: Optional[date] = None):
    """Evaluate with ``today`` = the last visit date (so VISIT_OVERDUE stays off)."""
    m = m or mother()
    if today is None:
        today = max((v.visit_date for v in visits), default=m.registered_on)
    return evaluate(m, visits, today)


def codes(results) -> List[str]:
    return [r.code for r in results]


def by_code(results, code: str) -> RuleResult:
    return next(r for r in results if r.code == code)


# ------------------------------------------------------------------ haemoglobin


@pytest.mark.parametrize(
    ("hb", "expected"),
    [
        (6.9, [("HB_SEVERE", "RED")]),
        (7.0, [("HB_MODERATE", "AMBER")]),
        (9.9, [("HB_MODERATE", "AMBER")]),
        (10.0, [("HB_MILD", "AMBER")]),
        (10.9, [("HB_MILD", "AMBER")]),
        (11.0, []),
    ],
)
def test_hb_thresholds(hb: float, expected) -> None:
    v = visit(100, hb=hb)
    res = run([v])
    assert [(r.code, r.severity) for r in res] == expected
    for r in res:
        assert r.source_visit_id == v.id


@pytest.mark.parametrize(
    ("hb", "reason"),
    [
        (6.9, "Hb 6.9 g/dL (<7.0): severe anaemia"),
        (9.9, "Hb 9.9 g/dL (7.0–9.9): moderate anaemia"),
        (10.0, "Hb 10.0 g/dL (10.0–10.9): mild anaemia, needs treatment follow-up"),
    ],
)
def test_hb_reason_has_reading_and_threshold(hb: float, reason: str) -> None:
    (r,) = run([visit(100, hb=hb)])
    assert r.reason == reason


def test_hb_uses_latest_reading_by_visit_date() -> None:
    res = run([visit(130, hb=12.0), visit(100, hb=6.5)])
    assert codes(res) == []
    res = run([visit(100, hb=12.0), visit(130, hb=6.5)])
    assert codes(res) == ["HB_SEVERE"]


def test_hb_latest_reading_skips_visits_without_hb() -> None:
    older = visit(100, hb=6.5)
    res = run([older, visit(130, weight=55.0)])
    assert codes(res) == ["HB_SEVERE"]
    assert res[0].source_visit_id == older.id


def test_hb_same_day_tie_broken_by_client_created_at() -> None:
    d = on_ga(100)
    early = visit(100, hb=6.5, created=datetime.combine(d, time(9, 0)))
    late = visit(100, hb=12.0, created=datetime.combine(d, time(11, 0)))
    # Input order must not matter; the later client_created_at wins.
    assert codes(run([late, early])) == []
    early2 = visit(100, hb=12.0, created=datetime.combine(d, time(9, 0)))
    late2 = visit(100, hb=6.5, created=datetime.combine(d, time(11, 0)))
    res = run([late2, early2])
    assert codes(res) == ["HB_SEVERE"]
    assert res[0].source_visit_id == late2.id


# ------------------------------------------------------------------ blood pressure


@pytest.mark.parametrize(
    ("bp", "expected"),
    [
        ((139, 80), []),
        ((140, 80), [("BP_HIGH", "AMBER")]),
        ((159, 80), [("BP_HIGH", "AMBER")]),
        ((160, 80), [("BP_SEVERE", "RED")]),
        ((120, 89), []),
        ((120, 90), [("BP_HIGH", "AMBER")]),
        ((130, 109), [("BP_HIGH", "AMBER")]),
        ((130, 110), [("BP_SEVERE", "RED")]),
    ],
)
def test_bp_thresholds(bp, expected) -> None:
    res = run([visit(100, bp=bp)])
    assert [(r.code, r.severity) for r in res] == expected


def test_bp_reasons() -> None:
    (r,) = run([visit(100, bp=(160, 100))])
    assert r.reason == "BP 160/100 (≥160/110): severe hypertension"
    (r,) = run([visit(100, bp=(141, 85))])
    assert r.reason == "BP 141/85 (≥140/90): high blood pressure"


def test_bp_145_92_alone_is_bp_high_amber() -> None:
    res = run([visit(100, bp=(145, 92))])
    assert [(r.code, r.severity) for r in res] == [("BP_HIGH", "AMBER")]
    assert worst(res) == "AMBER"


def test_bp_same_day_tie_broken_by_client_created_at() -> None:
    d = on_ga(100)
    early = visit(100, bp=(165, 100), created=datetime.combine(d, time(9, 0)))
    late = visit(100, bp=(120, 80), created=datetime.combine(d, time(11, 0)))
    assert codes(run([late, early])) == []
    early2 = visit(100, bp=(120, 80), created=datetime.combine(d, time(9, 0)))
    late2 = visit(100, bp=(165, 100), created=datetime.combine(d, time(11, 0)))
    assert codes(run([late2, early2])) == ["BP_SEVERE"]


# ------------------------------------------------------------------ weight: interval gaps


@pytest.mark.parametrize(("gap", "expected"), [(13, []), (14, ["WEIGHT_GAIN_LOW"])])
def test_gain_low_min_interval(gap: int, expected) -> None:
    res = run([visit(150 - gap, weight=55.0), visit(150, weight=55.0)])
    assert codes(res) == expected


@pytest.mark.parametrize(
    ("gap", "expected"), [(27, ["WEIGHT_GAIN_LOW"]), (28, ["WEIGHT_LOSS"])]
)
def test_loss_min_interval(gap: int, expected) -> None:
    # Below 28 days there is no loss reference; the low-gain rule (14 days) fires.
    res = run([visit(200 - gap, weight=57.5), visit(200, weight=56.0)])
    assert codes(res) == expected


@pytest.mark.parametrize(
    ("gap", "expected"), [(41, ["WEIGHT_GAIN_LOW"]), (42, ["WEIGHT_STATIC"])]
)
def test_static_min_interval(gap: int, expected) -> None:
    res = run([visit(200 - gap, weight=55.0), visit(200, weight=55.0)])
    assert codes(res) == expected


# ------------------------------------------------------------------ weight: GA thresholds


@pytest.mark.parametrize(("ga", "expected"), [(91, []), (92, ["WEIGHT_GAIN_LOW"])])
def test_gain_low_ga_threshold(ga: int, expected) -> None:
    res = run([visit(ga - 14, weight=50.0), visit(ga, weight=50.0)])
    assert codes(res) == expected


@pytest.mark.parametrize(
    ("ga_p", "expected"), [(97, ["WEIGHT_GAIN_LOW"]), (98, ["WEIGHT_STATIC"])]
)
def test_static_reference_ga_threshold(ga_p: int, expected) -> None:
    # P must itself be at GA >= 98 (2nd trimester); L is 42 days later.
    res = run([visit(ga_p, weight=52.0), visit(ga_p + 42, weight=52.0)])
    assert codes(res) == expected


@pytest.mark.parametrize(
    ("ga", "expected"), [(140, ["WEIGHT_GAIN_LOW"]), (141, ["WEIGHT_LOSS"])]
)
def test_loss_ga_threshold(ga: int, expected) -> None:
    res = run([visit(ga - 28, weight=57.5), visit(ga, weight=56.0)])
    assert codes(res) == expected


# ------------------------------------------------------------------ weight: amounts


@pytest.mark.parametrize(
    ("p_w", "l_w", "expected"),
    [
        (57.0, 56.0, ["WEIGHT_GAIN_LOW"]),  # exactly 1.0 kg: not > 1.0
        (57.1, 56.1, ["WEIGHT_GAIN_LOW"]),  # 1.0 with float noise
        (57.11, 56.1, ["WEIGHT_LOSS"]),
    ],
)
def test_loss_amount_threshold(p_w: float, l_w: float, expected) -> None:
    res = run([visit(170, weight=p_w), visit(200, weight=l_w)])
    assert codes(res) == expected


@pytest.mark.parametrize(
    ("l_w", "expected"),
    [
        (55.04, ["WEIGHT_STATIC"]),  # rounds to 0.0 kg gain
        (54.5, ["WEIGHT_STATIC"]),  # loss of 0.5 kg (not enough for WEIGHT_LOSS)
        (55.1, ["WEIGHT_GAIN_LOW"]),  # 0.1 kg gain: not static, still low
    ],
)
def test_static_gain_threshold(l_w: float, expected) -> None:
    res = run([visit(150, weight=55.0), visit(192, weight=l_w)])
    assert codes(res) == expected


@pytest.mark.parametrize(("l_w", "expected"), [(55.49, ["WEIGHT_GAIN_LOW"]), (55.5, [])])
def test_gain_low_rate_threshold(l_w: float, expected) -> None:
    # 0.5 kg over exactly 2 weeks is 0.25 kg/week: not below the threshold.
    res = run([visit(120, weight=55.0), visit(134, weight=l_w)])
    assert codes(res) == expected


def test_weight_reasons() -> None:
    res = run([visit(120, weight=55.0), visit(134, weight=55.2)])
    assert by_code(res, "WEIGHT_GAIN_LOW").reason == (
        "Weight gain 0.10 kg/week (<0.25) over 2 weeks"
    )
    res = run([visit(150, weight=55.0), visit(192, weight=55.0)])
    assert by_code(res, "WEIGHT_STATIC").reason == "No weight gain in 6 weeks (2nd/3rd trimester)"


def test_weight_rules_ignore_unweighed_visits() -> None:
    # The unweighed visit is later but L is the last *weighed* visit.
    res = run([visit(150, weight=55.0), visit(164, weight=55.0), visit(180, hb=12.0)])
    assert codes(res) == ["WEIGHT_GAIN_LOW"]


def test_weight_reference_is_most_recent_eligible_visit() -> None:
    # 170 is the most recent visit >= 28 days before 200, and only 0.5 kg higher;
    # the older, heavier visit at 150 must not be used.
    res = run(
        [visit(150, weight=59.0), visit(170, weight=56.5), visit(200, weight=56.0)]
    )
    assert "WEIGHT_LOSS" not in codes(res)


def test_gain_low_suppressed_by_loss_and_static() -> None:
    # LOSS and STATIC both apply (reference visit at GA 158); GAIN_LOW must not
    # appear. STATIC is intentionally not suppressed by LOSS (Req 14.3).
    res = run([visit(150, weight=58.0), visit(158, weight=58.0), visit(200, weight=56.0)])
    assert codes(res) == ["WEIGHT_LOSS", "WEIGHT_STATIC"]
    res = run([visit(170, weight=57.5), visit(200, weight=56.0)])
    assert codes(res) == ["WEIGHT_LOSS"]
    res = run([visit(150, weight=55.0), visit(192, weight=55.0)])
    assert codes(res) == ["WEIGHT_STATIC"]


def test_single_weight_produces_no_weight_rule() -> None:
    assert codes(run([visit(200, weight=40.0)])) == []


# ------------------------------------------------------------------ BMI, registration, gaps


@pytest.mark.parametrize(("w", "expected"), [(47.36, []), (47.35, ["BMI_LOW"])])
def test_bmi_threshold(w: float, expected) -> None:
    # 160 cm: BMI 18.5 at exactly 47.36 kg.
    m = mother(height_cm=160.0, first_weight_kg=w)
    res = run([], m=m)
    assert codes(res) == expected


def test_bmi_reason_and_baseline_fallback_to_earliest_visit() -> None:
    m = mother(height_cm=160.0, first_weight_kg=None)
    first = visit(70, weight=44.0)
    res = run([visit(75, weight=60.0), first], m=m)
    r = by_code(res, "BMI_LOW")
    assert r.reason == "BMI 17.2 at registration (<18.5)"
    assert r.source_visit_id == first.id


def test_bmi_needs_height() -> None:
    assert codes(run([], m=mother(height_cm=None, first_weight_kg=35.0))) == []


@pytest.mark.parametrize(("reg_ga", "expected"), [(84, []), (85, ["LATE_REG"])])
def test_late_registration_threshold(reg_ga: int, expected) -> None:
    res = run([], m=mother(reg_ga=reg_ga))
    assert codes(res) == expected


def test_late_registration_reason() -> None:
    (r,) = run([], m=mother(reg_ga=90))
    assert r.reason == "Registered late at 12 weeks (>12)"
    assert r.severity == "AMBER"


@pytest.mark.parametrize(("gap", "expected"), [(35, []), (36, ["VISIT_OVERDUE"])])
def test_visit_overdue_threshold(gap: int, expected) -> None:
    v = visit(100, hb=12.0)
    res = run([v], today=v.visit_date + timedelta(days=gap))
    assert codes(res) == expected
    if expected:
        assert res[0].reason == f"No visit for {gap} days (>35)"
        assert res[0].source_visit_id == v.id


@pytest.mark.parametrize(("gap", "expected"), [(35, []), (36, ["VISIT_OVERDUE"])])
def test_visit_overdue_without_visits_counts_from_registration(gap: int, expected) -> None:
    m = mother()
    res = evaluate(m, [], m.registered_on + timedelta(days=gap))
    assert codes(res) == expected
    if expected:
        assert res[0].source_visit_id is None


# ------------------------------------------------------------------ worst / delivered / order


def test_worst() -> None:
    assert worst([]) == "GREEN"
    assert worst(["AMBER"]) == "AMBER"
    assert worst(["AMBER", "RED", "AMBER"]) == "RED"
    amber = RuleResult("BP_HIGH", "AMBER", "x", None)
    red = RuleResult("HB_SEVERE", "RED", "y", None)
    assert worst([amber]) == "AMBER"
    assert worst([red, amber]) == "RED"


def test_delivered_mother_yields_no_results() -> None:
    m = mother(reg_ga=100, height_cm=150.0, first_weight_kg=35.0, status="delivered")
    visits = [visit(160, weight=58.0, hb=6.0, bp=(170, 115)), visit(200, weight=55.0)]
    assert evaluate(m, visits, on_ga(300)) == []


def test_results_follow_rule_table_order() -> None:
    m = mother(reg_ga=90, height_cm=160.0, first_weight_kg=44.0)
    visits = [visit(160, weight=58.0), visit(200, weight=56.0, hb=6.5, bp=(165, 100))]
    res = evaluate(m, visits, on_ga(240))
    assert codes(res) == [
        "HB_SEVERE",
        "BP_SEVERE",
        "WEIGHT_LOSS",
        "BMI_LOW",
        "LATE_REG",
        "VISIT_OVERDUE",
    ]
    assert worst(res) == "RED"


def test_every_reason_template_has_a_threshold() -> None:
    # Templates with a fixed comparison carry the threshold value in the text.
    for code, marker in {
        "HB_SEVERE": "<7.0",
        "HB_MODERATE": "7.0–9.9",
        "HB_MILD": "10.0–10.9",
        "BP_SEVERE": "≥160/110",
        "BP_HIGH": "≥140/90",
        "WEIGHT_LOSS": "after 20 weeks",
        "WEIGHT_GAIN_LOW": "<0.25",
        "BMI_LOW": "<18.5",
        "LATE_REG": ">12",
        "VISIT_OVERDUE": ">35",
    }.items():
        assert marker in REASONS[code], code


# ------------------------------------------------------------------ demo scenario (Req 40.5)


def test_demo_scenario_minimal() -> None:
    res = run([visit(154, weight=58.0), visit(182, weight=56.6, hb=6.8)])
    assert codes(res) == ["HB_SEVERE", "WEIGHT_LOSS"]
    assert by_code(res, "HB_SEVERE").reason == "Hb 6.8 g/dL (<7.0): severe anaemia"
    assert by_code(res, "WEIGHT_LOSS").reason == "Weight down 1.4 kg in 4 weeks after 20 weeks"
    assert worst(res) == "RED"


def test_demo_scenario_with_seeded_history() -> None:
    # Demo mother: ~26 weeks, normal gain, last visit 58.0 kg 30 days earlier.
    m = mother(reg_ga=70, height_cm=155.0, first_weight_kg=52.0)
    history = [
        visit(70, weight=52.4, hb=11.8, bp=(110, 70)),
        visit(98, weight=53.6, hb=11.6, bp=(112, 72)),
        visit(125, weight=55.6, hb=11.5, bp=(110, 70)),
        visit(152, weight=58.0, hb=11.4, bp=(112, 72)),
    ]
    assert codes(run(history, m=m)) == []  # GREEN before the demo visit
    demo = visit(182, weight=56.6, hb=6.8)
    res = run(history + [demo], m=m)
    assert codes(res) == ["HB_SEVERE", "WEIGHT_LOSS"]
    assert by_code(res, "HB_SEVERE").reason == "Hb 6.8 g/dL (<7.0): severe anaemia"
    assert by_code(res, "WEIGHT_LOSS").reason == "Weight down 1.4 kg in 4 weeks after 20 weeks"
    assert all(r.source_visit_id == demo.id for r in res)
