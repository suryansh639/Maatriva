"""Mock SMS outbox (Requirements 16.8, 17.1, 17.3; design §11).

``write`` only inserts a ``NotificationOutbox`` row in the caller's transaction:
it never calls ``begin_write`` (the caller already did) and never commits. This
module makes no network calls; the rows are read by the SMS-log panel only.

Privacy: SMS bodies identify a mother by her Short_Code (first 6 hex chars of her
UUID, uppercased) and never contain a mother's name or phone number. ``to_phone``
is the *recipient staff user's* phone, kept as the mock delivery address.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Iterable, Optional, Tuple

from sqlalchemy.orm import Session

from app.models import NotificationKind, NotificationOutbox, User, new_uuid
from app.timeutil import utcnow

MAX_BODY_LEN = 320
CHANNEL = "sms"
STATUS_MOCK_SENT = "mock_sent"

_KINDS = frozenset(k.value for k in NotificationKind)

# English labels for the action presets (Req 23.1), used in SMS text. Hindi labels
# live in the web app's i18n dictionary.
ACTION_LABELS_EN = {
    "HOME_VISIT_48H": "Home visit within 48 hours",
    "REFER_PHC": "Refer to PHC for evaluation",
    "IFA_PER_PROTOCOL": "Give/adjust IFA as per protocol",
    "REPEAT_HB": "Repeat Hb test",
    "BP_RECHECK": "Recheck BP",
    "ENSURE_THR": "Ensure take-home ration",
    "DIET_COUNSEL": "Diet counselling",
    "OTHER": "Other action",
}


# --------------------------------------------------------------------------- helpers


def short_code(mother_id: str) -> str:
    """Short_Code: the first 6 hex characters of the mother UUID, uppercased."""
    return mother_id.replace("-", "")[:6].upper()


def action_label(action_type: str) -> str:
    """English preset label; unknown codes fall back to the code itself."""
    return ACTION_LABELS_EN.get(action_type, action_type)


def _truncate(body: str) -> str:
    return body if len(body) <= MAX_BODY_LEN else body[:MAX_BODY_LEN]


# --------------------------------------------------------------------------- body builders


def red_alert_body(mother_id: str, village_name: str, first_reason: str) -> str:
    """``MAATRIVA RED: {SHORT} {village} - {first reason}. Open dashboard.``"""
    return _truncate(
        f"MAATRIVA RED: {short_code(mother_id)} {village_name} - {first_reason}. "
        "Open dashboard."
    )


def task_assigned_body(action_type: str, mother_id: str, due_date: date) -> str:
    """``MAATRIVA TASK: {action label} for {SHORT}, due {dd-mm}.``"""
    return _truncate(
        f"MAATRIVA TASK: {action_label(action_type)} for {short_code(mother_id)}, "
        f"due {due_date.strftime('%d-%m')}."
    )


def task_done_body(action_type: str, mother_id: str, asha_username: str) -> str:
    """``MAATRIVA DONE: {action label} for {SHORT} by {asha username}.``"""
    return _truncate(
        f"MAATRIVA DONE: {action_label(action_type)} for {short_code(mother_id)} "
        f"by {asha_username}."
    )


def amber_digest_body(village_counts: Iterable[Tuple[str, int]]) -> str:
    """``MAATRIVA AMBER digest: {village} {n}; {village} {n}; ...`` (counts only)."""
    parts = [f"{name} {n}" for name, n in village_counts]
    summary = "; ".join(parts) if parts else "no open AMBER cases"
    return _truncate(f"MAATRIVA AMBER digest: {summary}")


# --------------------------------------------------------------------------- writer


def write(
    session: Session,
    kind: str,
    facility_id: str,
    to_user: Optional[User],
    body: str,
    related_alert_id: Optional[str] = None,
    related_task_id: Optional[str] = None,
    *,
    now: Optional[datetime] = None,
) -> NotificationOutbox:
    """Add one mock SMS row to ``session`` (no commit, no network).

    ``facility_id`` is the mother's facility, or the sender's for ``amber_digest``.
    ``now`` defaults to ``utcnow()``; the seed passes its own clock.
    """
    kind_value = kind.value if isinstance(kind, NotificationKind) else kind
    if kind_value not in _KINDS:
        raise ValueError(f"unknown notification kind: {kind_value!r}")
    row = NotificationOutbox(
        id=new_uuid(),
        facility_id=facility_id,
        channel=CHANNEL,
        kind=kind_value,
        to_user_id=to_user.id if to_user is not None else None,
        to_phone=to_user.phone if to_user is not None else None,
        body=_truncate(body),
        status=STATUS_MOCK_SENT,
        related_alert_id=related_alert_id,
        related_task_id=related_task_id,
        created_at=now if now is not None else utcnow(),
    )
    session.add(row)
    return row


__all__ = [
    "MAX_BODY_LEN",
    "ACTION_LABELS_EN",
    "short_code",
    "action_label",
    "red_alert_body",
    "task_assigned_body",
    "task_done_body",
    "amber_digest_body",
    "write",
]
