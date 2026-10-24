"""ORM models (technical source §5).

Conventions:
- Every primary key is a lowercase canonical 36-character UUID string, except
  ``SyncCounter.id`` which is the integer ``1``.
- Datetimes are naive UTC (``DateTime`` without tz); serialize with ``timeutil.iso_z``.
  Dates are IST calendar dates.
- Enumerations are stored as plain strings (portable across SQLite/PostgreSQL); the
  ``str, Enum`` classes below are the allowed values, validated in ``app.schemas``.
- Mother, Visit and Task carry an indexed ``change_seq``: the value returned by
  ``db.begin_write`` for the transaction that last wrote the row. It has no default
  on purpose, so a write path that forgets to stamp it fails loudly.
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime
from enum import Enum
from typing import List, Optional

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    event,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.timeutil import utcnow

LBW_THRESHOLD_KG = 2.5


def new_uuid() -> str:
    """Server-generated id: lowercase canonical uuid4 string."""
    return str(uuid.uuid4())


def compute_is_lbw(birth_weight_kg: Optional[float]) -> bool:
    """Low birth weight: True iff a weight is recorded and it is below 2.5 kg."""
    return birth_weight_kg is not None and birth_weight_kg < LBW_THRESHOLD_KG


# --------------------------------------------------------------------------- enums


class Role(str, Enum):
    asha = "asha"
    anm = "anm"
    doctor = "doctor"
    admin = "admin"


class MotherStatus(str, Enum):
    active = "active"
    delivered = "delivered"


class RiskLevel(str, Enum):
    GREEN = "GREEN"
    AMBER = "AMBER"
    RED = "RED"


class FlagSeverity(str, Enum):
    RED = "RED"
    AMBER = "AMBER"
    INFO = "INFO"


class WeightSource(str, Enum):
    manual = "manual"
    ble = "ble"
    simulated = "simulated"


class HbSource(str, Enum):
    manual = "manual"
    device = "device"


class BpSource(str, Enum):
    manual = "manual"
    ble = "ble"
    simulated = "simulated"


class AlertRecipientRole(str, Enum):
    doctor = "doctor"
    anm = "anm"


class AlertSeverity(str, Enum):
    RED = "RED"
    AMBER = "AMBER"


class AlertStatus(str, Enum):
    open = "open"
    acknowledged = "acknowledged"
    actioned = "actioned"
    closed = "closed"


class TaskStatus(str, Enum):
    open = "open"
    done = "done"
    cancelled = "cancelled"


class NotificationKind(str, Enum):
    red_alert = "red_alert"
    task_assigned = "task_assigned"
    amber_digest = "amber_digest"
    task_done = "task_done"


class BirthOutcomeKind(str, Enum):
    live_birth = "live_birth"
    stillbirth = "stillbirth"


# --------------------------------------------------------------------------- sync counter


class SyncCounter(Base):
    """Single row (id=1). ``db.begin_write`` / ``db.rotate_epoch`` address it with raw
    SQL, so the table and column names here must not change."""

    __tablename__ = "sync_counter"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    value: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    epoch: Mapped[str] = mapped_column(String(36), nullable=False, default=new_uuid)


# --------------------------------------------------------------------------- org structure


class Facility(Base):
    __tablename__ = "facility"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    district: Mapped[str] = mapped_column(String(100), nullable=False)
    state: Mapped[str] = mapped_column(String(100), nullable=False)
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lng: Mapped[float] = mapped_column(Float, nullable=False)

    villages: Mapped[List["Village"]] = relationship(
        back_populates="facility", order_by="Village.name"
    )
    users: Mapped[List["User"]] = relationship(back_populates="facility")


class Village(Base):
    __tablename__ = "village"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    facility_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("facility.id"), nullable=False, index=True
    )
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lng: Mapped[float] = mapped_column(Float, nullable=False)

    facility: Mapped[Facility] = relationship(back_populates="villages")


class User(Base):
    __tablename__ = "user"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    username: Mapped[str] = mapped_column(String(40), nullable=False, unique=True)
    password_hash: Mapped[str] = mapped_column(String(200), nullable=False)
    full_name: Mapped[str] = mapped_column(String(100), nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False)  # Role
    # Null only for admin users.
    facility_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("facility.id"), nullable=True, index=True
    )
    phone: Mapped[Optional[str]] = mapped_column(String(15), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)

    facility: Mapped[Optional[Facility]] = relationship(back_populates="users")
    villages: Mapped[List[Village]] = relationship(
        secondary="user_village", order_by="Village.name", viewonly=True
    )


class UserVillage(Base):
    """ASHA (and optionally ANM) village assignment. Invariant:
    ``village.facility_id == user.facility_id`` (asserted by the seed, and filtered
    again in ``deps.get_current_user``)."""

    __tablename__ = "user_village"

    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("user.id"), primary_key=True)
    village_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("village.id"), primary_key=True, index=True
    )

    user: Mapped[User] = relationship()
    village: Mapped[Village] = relationship()


# --------------------------------------------------------------------------- clinical


class Mother(Base):
    __tablename__ = "mother"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)  # client UUID
    full_name: Mapped[str] = mapped_column(String(100), nullable=False)
    age: Mapped[int] = mapped_column(Integer, nullable=False)
    guardian_name: Mapped[str] = mapped_column(String(100), nullable=False)
    village_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("village.id"), nullable=False, index=True
    )
    # Server-derived from the village (denormalized for doctor queries).
    facility_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("facility.id"), nullable=False, index=True
    )
    # Set once at insert to the registering ASHA; never changed by later upserts.
    asha_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("user.id"), nullable=False, index=True
    )
    phone: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    lmp_date: Mapped[date] = mapped_column(Date, nullable=False)
    edd_date: Mapped[date] = mapped_column(Date, nullable=False)  # server-computed
    is_bpl: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    height_cm: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    first_weight_kg: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    registered_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)  # client
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=MotherStatus.active.value
    )
    risk_level: Mapped[str] = mapped_column(
        String(8), nullable=False, default=RiskLevel.GREEN.value
    )
    risk_updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    # Client clock; last-write-wins key for mother/upsert.
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    change_seq: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)

    village: Mapped[Village] = relationship()
    facility: Mapped[Facility] = relationship()
    asha: Mapped[User] = relationship(foreign_keys=[asha_id])
    visits: Mapped[List["Visit"]] = relationship(
        back_populates="mother",
        order_by="(Visit.visit_date, Visit.client_created_at)",
    )
    flags: Mapped[List["RiskFlag"]] = relationship(back_populates="mother")
    tasks: Mapped[List["Task"]] = relationship(back_populates="mother")
    alerts: Mapped[List["Alert"]] = relationship(back_populates="mother")
    birth_outcome: Mapped[Optional["BirthOutcome"]] = relationship(
        back_populates="mother", uselist=False
    )


class Visit(Base):
    """Immutable once synced (create-only in the MVP)."""

    __tablename__ = "visit"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)  # client UUID
    mother_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("mother.id"), nullable=False, index=True
    )
    visit_date: Mapped[date] = mapped_column(Date, nullable=False)
    weight_kg: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    weight_source: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    # Raw 0x2A9D payload: lowercase hex, no spaces (audit trail).
    ble_raw_hex: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    hb_gdl: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    hb_source: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    bp_systolic: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    bp_diastolic: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    bp_source: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    ifa_tablets: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    calcium_tablets: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    thr_received: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    recorded_by_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("user.id"), nullable=False
    )
    device_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    client_created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    change_seq: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)

    mother: Mapped[Mother] = relationship(back_populates="visits")


class RiskFlag(Base):
    """At most one active row per (mother_id, code); ``apply_triage`` is the only
    writer (plus birth-outcome resolution), both under ``db.begin_write``."""

    __tablename__ = "risk_flag"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    mother_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("mother.id"), nullable=False, index=True
    )
    code: Mapped[str] = mapped_column(String(32), nullable=False)
    severity: Mapped[str] = mapped_column(String(8), nullable=False)  # FlagSeverity
    reason: Mapped[str] = mapped_column(String(300), nullable=False)
    # SET NULL so demo visit deletes keep flag history instead of failing the FK.
    source_visit_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("visit.id", ondelete="SET NULL"), nullable=True
    )
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    last_evaluated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=utcnow
    )
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    mother: Mapped[Mother] = relationship(back_populates="flags")


class Alert(Base):
    __tablename__ = "alert"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    mother_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("mother.id"), nullable=False, index=True
    )
    facility_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("facility.id"), nullable=False, index=True
    )
    recipient_role: Mapped[str] = mapped_column(String(16), nullable=False)
    severity: Mapped[str] = mapped_column(String(8), nullable=False)  # AlertSeverity
    flag_codes: Mapped[str] = mapped_column(String, nullable=False, default="[]")  # JSON
    summary: Mapped[str] = mapped_column(String(300), nullable=False)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=AlertStatus.open.value
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    acknowledged_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    closed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    mother: Mapped[Mother] = relationship(back_populates="alerts")
    tasks: Mapped[List["Task"]] = relationship(back_populates="alert")

    @property
    def codes(self) -> List[str]:
        """``flag_codes`` decoded from its JSON array text."""
        return list(json.loads(self.flag_codes)) if self.flag_codes else []

    @codes.setter
    def codes(self, value: List[str]) -> None:
        self.flag_codes = json.dumps(list(value))


class Task(Base):
    """Doctor action for the mother's ASHA. ``is_overdue`` is derived, never stored."""

    __tablename__ = "task"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    mother_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("mother.id"), nullable=False, index=True
    )
    alert_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("alert.id"), nullable=True, index=True
    )
    issued_by_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("user.id"), nullable=False
    )
    # Copied from the mother at issue time.
    asha_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("user.id"), nullable=False, index=True
    )
    action_type: Mapped[str] = mapped_column(String(32), nullable=False)
    instructions: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    due_date: Mapped[date] = mapped_column(Date, nullable=False)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=TaskStatus.open.value
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    done_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    done_note: Mapped[Optional[str]] = mapped_column(String(300), nullable=True)
    change_seq: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)

    mother: Mapped[Mother] = relationship(back_populates="tasks")
    alert: Mapped[Optional[Alert]] = relationship(back_populates="tasks")
    issued_by: Mapped[User] = relationship(foreign_keys=[issued_by_id])
    asha: Mapped[User] = relationship(foreign_keys=[asha_id])

    def is_overdue(self, today: date) -> bool:
        return self.status == TaskStatus.open.value and self.due_date < today


class NotificationOutbox(Base):
    """Mock SMS rows. Never sent anywhere; the SMS-log panel reads them."""

    __tablename__ = "notification_outbox"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    # Scoping column: the mother's facility, or the sender's for amber_digest.
    facility_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("facility.id"), nullable=False, index=True
    )
    channel: Mapped[str] = mapped_column(String(8), nullable=False, default="sms")
    kind: Mapped[str] = mapped_column(String(16), nullable=False)  # NotificationKind
    to_user_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("user.id"), nullable=True
    )
    to_phone: Mapped[Optional[str]] = mapped_column(String(15), nullable=True)
    body: Mapped[str] = mapped_column(String(320), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="mock_sent")
    # Plain columns, not FKs.
    related_alert_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    related_task_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=utcnow, index=True
    )


class BirthOutcome(Base):
    __tablename__ = "birth_outcome"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    mother_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("mother.id"), nullable=False, unique=True
    )
    delivery_date: Mapped[date] = mapped_column(Date, nullable=False)
    outcome: Mapped[str] = mapped_column(String(16), nullable=False)  # BirthOutcomeKind
    birth_weight_kg: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    # Server-computed from birth_weight_kg (see _sync_is_lbw); never client-supplied.
    is_lbw: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    recorded_by_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("user.id"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)

    mother: Mapped[Mother] = relationship(back_populates="birth_outcome")

    def __init__(self, **kwargs):
        kwargs.pop("is_lbw", None)
        super().__init__(**kwargs)
        self.is_lbw = compute_is_lbw(self.birth_weight_kg)


@event.listens_for(BirthOutcome, "before_insert")
@event.listens_for(BirthOutcome, "before_update")
def _sync_is_lbw(_mapper, _connection, target: BirthOutcome) -> None:
    """Keep ``is_lbw`` derived from ``birth_weight_kg`` on every flush."""
    target.is_lbw = compute_is_lbw(target.birth_weight_kg)


__all__ = [
    "LBW_THRESHOLD_KG",
    "new_uuid",
    "compute_is_lbw",
    "Role",
    "MotherStatus",
    "RiskLevel",
    "FlagSeverity",
    "WeightSource",
    "HbSource",
    "BpSource",
    "AlertRecipientRole",
    "AlertSeverity",
    "AlertStatus",
    "TaskStatus",
    "NotificationKind",
    "BirthOutcomeKind",
    "SyncCounter",
    "Facility",
    "Village",
    "User",
    "UserVillage",
    "Mother",
    "Visit",
    "RiskFlag",
    "Alert",
    "Task",
    "NotificationOutbox",
    "BirthOutcome",
]
