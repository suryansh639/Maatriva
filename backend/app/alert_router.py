"""Alert routing and lifecycle (Requirements 10.5, 16.1–16.5, 16.8, 16.9; design §11).

``route`` and ``on_task_done`` run inside the caller's writing transaction: the
caller has already called ``db.begin_write`` and commits afterwards. Nothing here
begins a write, commits, or publishes. Both return events as
``(facility_id, event_name, payload)`` tuples, the same shape as
``TriageOutcome.events``, for the caller to publish after its commit (Req 18.6).

Live alerts:
- RED: the mother's single ``severity=RED`` alert with status in ``LIVE_RED``.
- AMBER: her single ``severity=AMBER`` alert with status ``open``.

Only RED (doctor) alerts produce events; AMBER (ANM) alerts are never published
and never page the doctor. Log calls reference ids only, never names or phones.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session, object_session

from app import notifications
from app.models import (
    Alert,
    AlertRecipientRole,
    AlertSeverity,
    AlertStatus,
    Mother,
    NotificationKind,
    RiskFlag,
    Role,
    Task,
    TaskStatus,
    User,
    new_uuid,
)
from app.timeutil import iso_z

log = logging.getLogger(__name__)

Event = Tuple[str, str, Dict[str, Any]]

LIVE_RED: Tuple[str, ...] = (
    AlertStatus.open.value,
    AlertStatus.acknowledged.value,
    AlertStatus.actioned.value,
)
LIVE_AMBER: Tuple[str, ...] = (AlertStatus.open.value,)

_SUMMARY_MAX = 300  # Alert.summary column length


# --------------------------------------------------------------------------- serialization


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return iso_z(dt) if dt is not None else None


def _flag_reasons(session: Optional[Session], mother_id: str, codes: Sequence[str]) -> List[str]:
    """Reasons of the mother's active flags for ``codes``, in ``codes`` order."""
    if session is None or not codes:
        return []
    rows = session.execute(
        select(RiskFlag.code, RiskFlag.reason).where(
            RiskFlag.mother_id == mother_id,
            RiskFlag.active.is_(True),
            RiskFlag.code.in_(list(codes)),
        )
    ).all()
    by_code = {code: reason for code, reason in rows}
    return [by_code[c] for c in codes if c in by_code]


def alert_out(
    alert: Alert,
    *,
    mother: Optional[Mother] = None,
    reasons: Optional[Sequence[str]] = None,
    session: Optional[Session] = None,
) -> Dict[str, Any]:
    """Serialize an alert as ``AlertOut`` (technical source §8.2):
    ``id, mother_id, mother_name, village_name, recipient_role, severity, status,
    flag_codes, summary, reasons, created_at, updated_at, acknowledged_at, closed_at``.

    ``mother`` defaults to ``alert.mother``. ``reasons`` defaults to the reasons of
    the mother's active flags for the alert's codes (looked up through ``session``,
    or the alert's own session); route passes the fresh triage reasons directly.
    """
    m = mother if mother is not None else alert.mother
    codes = alert.codes
    if reasons is None:
        reasons = _flag_reasons(session or object_session(alert), alert.mother_id, codes)
    return {
        "id": alert.id,
        "mother_id": alert.mother_id,
        "mother_name": m.full_name if m is not None else None,
        "village_name": m.village.name if m is not None and m.village is not None else None,
        "recipient_role": alert.recipient_role,
        "severity": alert.severity,
        "status": alert.status,
        "flag_codes": codes,
        "summary": alert.summary,
        "reasons": list(reasons),
        "created_at": _iso(alert.created_at),
        "updated_at": _iso(alert.updated_at),
        "acknowledged_at": _iso(alert.acknowledged_at),
        "closed_at": _iso(alert.closed_at),
    }


def created_event(alert: Alert, **kw) -> Event:
    """``alert.created`` with payload ``{"alert": AlertOut}``."""
    return (alert.facility_id, "alert.created", {"alert": alert_out(alert, **kw)})


def updated_event(alert: Alert, new_codes: Iterable[str] = (), **kw) -> Event:
    """``alert.updated`` with payload ``{"alert": AlertOut, "new_codes": [...]}``.
    ``new_codes`` is empty for status-only changes (ack, actioned, closed)."""
    return (
        alert.facility_id,
        "alert.updated",
        {"alert": alert_out(alert, **kw), "new_codes": list(new_codes)},
    )


# --------------------------------------------------------------------------- helpers


def find_alert(
    session: Session, mother_id: str, severity: str, statuses: Sequence[str]
) -> Optional[Alert]:
    """The mother's newest alert of ``severity`` whose status is in ``statuses``."""
    return session.execute(
        select(Alert)
        .where(
            Alert.mother_id == mother_id,
            Alert.severity == severity,
            Alert.status.in_(list(statuses)),
        )
        .order_by(Alert.created_at.desc(), Alert.id.desc())
        .limit(1)
    ).scalar_one_or_none()


def _summary(results: Sequence[Any]) -> str:
    return results[0].reason[:_SUMMARY_MAX] if results else ""


def _create_alert(
    session: Session, mother: Mother, recipient_role: str, severity: str, results, now: datetime
) -> Alert:
    alert = Alert(
        id=new_uuid(),
        mother_id=mother.id,
        facility_id=mother.facility_id,
        recipient_role=recipient_role,
        severity=severity,
        summary=_summary(results),
        status=AlertStatus.open.value,
        created_at=now,
        updated_at=now,
    )
    alert.codes = [r.code for r in results]
    session.add(alert)
    return alert


def _update_alert(alert: Alert, results, now: datetime) -> None:
    alert.codes = [r.code for r in results]
    alert.summary = _summary(results)
    alert.updated_at = now


def _close(alert: Optional[Alert], now: datetime) -> bool:
    if alert is None or alert.status == AlertStatus.closed.value:
        return False
    alert.status = AlertStatus.closed.value
    alert.closed_at = now
    alert.updated_at = now
    return True


def _write_red_sms(
    session: Session, mother: Mother, alert: Alert, first_reason: str, now: datetime
) -> int:
    """One ``red_alert`` mock SMS per doctor of the mother's facility (Req 16.8).
    With no doctor the alert stands and a WARNING is logged (Req 16.9)."""
    doctors = (
        session.execute(
            select(User)
            .where(User.role == Role.doctor.value, User.facility_id == mother.facility_id)
            .order_by(User.username)
        )
        .scalars()
        .all()
    )
    if not doctors:
        log.warning(
            "RED alert %s for mother %s: facility %s has no doctor, no SMS written",
            alert.id,
            mother.id,
            mother.facility_id,
        )
        return 0
    body = notifications.red_alert_body(mother.id, mother.village.name, first_reason)
    for doctor in doctors:
        notifications.write(
            session,
            NotificationKind.red_alert,
            mother.facility_id,
            doctor,
            body,
            related_alert_id=alert.id,
            now=now,
        )
    return len(doctors)


# --------------------------------------------------------------------------- routing


def route(
    session: Session,
    mother: Mother,
    results: Sequence[Any],
    newly_active: Set[str],
    new_evidence: Set[str],
    now: datetime,
) -> List[Event]:
    """Create, update or close the mother's alerts from the current triage results.

    ``results`` are the ``RuleResult`` items of this run. ``newly_active`` holds the
    codes active now but not before the run; ``new_evidence`` holds still-active
    codes whose ``source_visit_id`` changed to a newer visit.

    RED (doctor):
    - no live alert, and a RED code is newly active or has new evidence: create
      one, SMS each doctor, emit ``alert.created``;
    - live alert and a RED code is newly active: update codes/summary, reopen it if
      ``actioned``, SMS each doctor, emit ``alert.updated`` with ``new_codes``;
    - live alert with only new evidence, or RED codes only resolving: no change.
      A RED alert is never closed here (Req 16.3).

    AMBER (ANM, never published, no doctor SMS): closed when the mother has a RED
    code or no AMBER code; otherwise created, or updated when its code set changed.
    """
    red = [r for r in results if r.severity == AlertSeverity.RED.value]
    amber = [r for r in results if r.severity == AlertSeverity.AMBER.value]
    red_codes = {r.code for r in red}
    new_red = red_codes & set(newly_active)
    red_new_evidence = red_codes & set(new_evidence)
    red_reasons = [r.reason for r in red]
    events: List[Event] = []

    live_red = find_alert(session, mother.id, AlertSeverity.RED.value, LIVE_RED)
    if live_red is None:
        if new_red or red_new_evidence:
            alert = _create_alert(
                session, mother, AlertRecipientRole.doctor.value, AlertSeverity.RED.value, red, now
            )
            _write_red_sms(session, mother, alert, red[0].reason, now)
            log.info("RED alert %s created for mother %s", alert.id, mother.id)
            events.append(created_event(alert, mother=mother, reasons=red_reasons))
    elif new_red:
        _update_alert(live_red, red, now)
        if live_red.status == AlertStatus.actioned.value:
            live_red.status = AlertStatus.open.value
        _write_red_sms(session, mother, live_red, red[0].reason, now)
        log.info("RED alert %s updated for mother %s", live_red.id, mother.id)
        events.append(
            updated_event(live_red, sorted(new_red), mother=mother, reasons=red_reasons)
        )

    live_amber = find_alert(session, mother.id, AlertSeverity.AMBER.value, LIVE_AMBER)
    if red or not amber:
        _close(live_amber, now)  # Req 16.5
    elif live_amber is None:
        _create_alert(
            session, mother, AlertRecipientRole.anm.value, AlertSeverity.AMBER.value, amber, now
        )
    elif set(live_amber.codes) != {r.code for r in amber}:
        _update_alert(live_amber, amber, now)

    return events


def on_task_done(session: Session, task: Task, now: datetime) -> List[Event]:
    """Req 10.5: when ``task`` (already set ``done`` by the caller) links to an
    alert that is not closed and no other open task links to it, close the alert
    and return ``alert.updated`` (RED alerts only; AMBER is never published)."""
    if task.alert_id is None:
        return []
    alert = session.get(Alert, task.alert_id)
    if alert is None or alert.status == AlertStatus.closed.value:
        return []
    other_open = session.execute(
        select(Task.id)
        .where(
            Task.alert_id == alert.id,
            Task.id != task.id,
            Task.status == TaskStatus.open.value,
        )
        .limit(1)
    ).first()
    if other_open is not None:
        return []
    _close(alert, now)
    log.info("alert %s closed by task %s", alert.id, task.id)
    if alert.severity != AlertSeverity.RED.value:
        return []
    return [updated_event(alert, (), session=session)]


__all__ = [
    "LIVE_RED",
    "LIVE_AMBER",
    "Event",
    "alert_out",
    "created_event",
    "updated_event",
    "find_alert",
    "route",
    "on_task_done",
]
