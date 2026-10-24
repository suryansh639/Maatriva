"""Sync wire schemas and shared output models (Requirements 7.1, 7.5, 8.1, 11, 12).

Input models (``MotherIn``, ``VisitIn``, ``TaskCompleteIn``) validate one push
change's ``data``. They need no database and run before ``db.begin_write``. Every
failure maps to ``VALIDATION_ERROR`` with ``first_error_message(exc)``. Checks that
need the database (scope, ``visit_date`` against the mother's LMP) run at apply time.

The server time comes from the validation context, so tests can pin it::

    MotherIn.model_validate(data, context={"now": now_naive_utc})

Without a context the real ``timeutil.utcnow()`` is used.

Normalization rules (mirrored in ``web/src/field/validation.ts``, checked by both
suites against ``tests/fixtures/validation_vectors.json``):

- UUIDs must be canonical 8-4-4-4-12 hex (any case) and are stored lowercase.
- Names are trimmed, then must be 1-100 characters.
- A blank ``phone`` ("" or whitespace) is treated as absent.
- Weights are rounded to 2 dp and Hb to 1 dp, after the range check.
- ``ble_raw_hex`` is lowercased with spaces removed, then checked.
- Datetime strings must carry a timezone (``Z`` or ``±hh:mm``) and are converted to
  naive UTC. Datetime objects from Python callers are converted the same way, a
  naive one being taken as UTC.
- Integer fields are strict (no floats, strings or booleans). Float fields accept
  ints and floats only.
"""
from __future__ import annotations

import re
import uuid
from datetime import date, datetime, timedelta
from typing import Annotated, Any, Dict, List, Literal, Optional, Tuple

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    PlainSerializer,
    StrictBool,
    StrictStr,
    StringConstraints,
    TypeAdapter,
    ValidationError,
    ValidationInfo,
    field_validator,
    model_validator,
)
from pydantic_core import PydanticCustomError

from app.gestation import ga_days
from app.timeutil import ist_date, iso_z, to_utc_naive, utcnow

# --------------------------------------------------------------------------- limits

NAME_MAX = 100
AGE_MIN, AGE_MAX = 14, 55
PHONE_RE = r"^[6-9][0-9]{9}$"
GA_AT_REGISTRATION_MAX = 308
HEIGHT_MIN, HEIGHT_MAX = 120.0, 200.0
WEIGHT_MIN, WEIGHT_MAX = 25.0, 150.0
HB_MIN, HB_MAX = 3.0, 20.0
BP_SYS_MIN, BP_SYS_MAX = 60, 260
BP_DIA_MIN, BP_DIA_MAX = 30, 160
TABLETS_MIN, TABLETS_MAX = 0, 180
NOTES_MAX = 500
DONE_NOTE_MAX = 300
FUTURE_SKEW = timedelta(hours=24)
BLE_HEX_RE = r"^(?:[0-9a-f]{2}){0,40}$"

_UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
_DATE_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_DATETIME_PREFIX_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}")

# --------------------------------------------------------------------------- context


def context_now(info: Optional[ValidationInfo]) -> datetime:
    """Server time (naive UTC) from the validation context, else the real clock."""
    ctx = info.context if info is not None else None
    now = ctx.get("now") if isinstance(ctx, dict) else None
    return to_utc_naive(now) if isinstance(now, datetime) else utcnow()


# --------------------------------------------------------------------------- uuids


def normalize_uuid_or_none(value: Any) -> Optional[str]:
    """Lowercase canonical UUID string, or None when ``value`` is not one.

    Used for ``ChangeResult.id`` (Req 7.6) with the same rule as ``UuidStr``.
    """
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, str) and _UUID_RE.fullmatch(value):
        return value.lower()
    return None


def _parse_uuid(value: Any) -> str:
    normalized = normalize_uuid_or_none(value)
    if normalized is None:
        raise PydanticCustomError("uuid_parsing", "Input should be a valid UUID")
    return normalized


UuidStr = Annotated[str, BeforeValidator(_parse_uuid)]

# --------------------------------------------------------------------------- strings

NameStr = Annotated[
    StrictStr, StringConstraints(strip_whitespace=True, min_length=1, max_length=NAME_MAX)
]


def _blank_to_none(value: Any) -> Any:
    if isinstance(value, str) and not value.strip():
        return None
    return value


PhoneStr = Annotated[
    Optional[Annotated[StrictStr, StringConstraints(pattern=PHONE_RE)]],
    BeforeValidator(_blank_to_none),
]


def _normalize_hex(value: Any) -> Any:
    if isinstance(value, str):
        return value.lower().replace(" ", "")
    return value


BleHexStr = Annotated[
    Annotated[StrictStr, StringConstraints(pattern=BLE_HEX_RE)],
    BeforeValidator(_normalize_hex),
]

NotesStr = Annotated[StrictStr, StringConstraints(max_length=NOTES_MAX)]
DoneNoteStr = Annotated[StrictStr, StringConstraints(max_length=DONE_NOTE_MAX)]

# --------------------------------------------------------------------------- numbers


def _round2(x: float) -> float:
    return round(float(x), 2)


def _round1(x: float) -> float:
    return round(float(x), 1)


AgeInt = Annotated[int, Field(strict=True, ge=AGE_MIN, le=AGE_MAX)]
HeightCm = Annotated[
    float, Field(strict=True, ge=HEIGHT_MIN, le=HEIGHT_MAX, allow_inf_nan=False)
]
WeightKg = Annotated[
    float,
    Field(strict=True, ge=WEIGHT_MIN, le=WEIGHT_MAX, allow_inf_nan=False),
    AfterValidator(_round2),
]
HbGdl = Annotated[
    float,
    Field(strict=True, ge=HB_MIN, le=HB_MAX, allow_inf_nan=False),
    AfterValidator(_round1),
]
SystolicInt = Annotated[int, Field(strict=True, ge=BP_SYS_MIN, le=BP_SYS_MAX)]
DiastolicInt = Annotated[int, Field(strict=True, ge=BP_DIA_MIN, le=BP_DIA_MAX)]
TabletsInt = Annotated[int, Field(strict=True, ge=TABLETS_MIN, le=TABLETS_MAX)]

# --------------------------------------------------------------------------- dates


def _parse_date(value: Any) -> date:
    """``YYYY-MM-DD`` strings or ``date`` objects only (no timestamps, no datetimes)."""
    if isinstance(value, datetime):
        raise PydanticCustomError("date_type", "Input should be a date, not a datetime")
    if isinstance(value, date):
        return value
    if isinstance(value, str) and _DATE_RE.fullmatch(value):
        try:
            return date.fromisoformat(value)
        except ValueError:
            pass
    raise PydanticCustomError(
        "date_parsing", "Input should be a valid date in YYYY-MM-DD format"
    )


IsoDate = Annotated[date, BeforeValidator(_parse_date)]

_DATETIME_ADAPTER = TypeAdapter(datetime)


def _parse_datetime(value: Any) -> datetime:
    """ISO-8601 string with a timezone, or a ``datetime`` object → naive UTC."""
    if isinstance(value, datetime):
        return to_utc_naive(value)
    if not isinstance(value, str) or not _DATETIME_PREFIX_RE.match(value):
        raise PydanticCustomError(
            "datetime_parsing", "Input should be a valid ISO-8601 datetime"
        )
    try:
        parsed = _DATETIME_ADAPTER.validate_python(value)
    except ValidationError:
        raise PydanticCustomError(
            "datetime_parsing", "Input should be a valid ISO-8601 datetime"
        ) from None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise PydanticCustomError(
            "datetime_timezone", "Datetime must include a timezone (Z or +hh:mm)"
        )
    return to_utc_naive(parsed)


def _not_too_far_ahead(value: datetime, info: ValidationInfo) -> datetime:
    if value > context_now(info) + FUTURE_SKEW:
        raise PydanticCustomError(
            "datetime_future", "Datetime must not be more than 24 hours after server time"
        )
    return value


ClientDatetime = Annotated[
    datetime, BeforeValidator(_parse_datetime), AfterValidator(_not_too_far_ahead)
]

# --------------------------------------------------------------------------- enums

WeightSourceLit = Literal["manual", "ble", "simulated"]
HbSourceLit = Literal["manual", "device"]
BpSourceLit = Literal["manual", "ble", "simulated"]


def _model_error(field: str, message: str) -> PydanticCustomError:
    """Cross-field error; the field name is put in the message because model-level
    errors have an empty ``loc``."""
    return PydanticCustomError("cross_field", "{field}: {message}", {"field": field, "message": message})


# --------------------------------------------------------------------------- input models


class MotherIn(BaseModel):
    """``mother/upsert`` data. ``extra="ignore"`` drops server-owned fields a client
    may send (``risk_level``, ``edd_date``, ``asha_id``, ``facility_id``, ``status``)."""

    model_config = ConfigDict(extra="ignore")

    id: UuidStr
    full_name: NameStr
    age: AgeInt
    guardian_name: NameStr
    village_id: UuidStr
    phone: PhoneStr = None
    lmp_date: IsoDate
    is_bpl: StrictBool
    height_cm: Optional[HeightCm] = None
    first_weight_kg: Optional[WeightKg] = None
    registered_at: ClientDatetime
    updated_at: ClientDatetime

    @field_validator("lmp_date")
    @classmethod
    def _lmp_not_in_future(cls, value: date, info: ValidationInfo) -> date:
        if value > ist_date(context_now(info)):
            raise PydanticCustomError("date_future", "LMP date must not be after today (IST)")
        return value

    @model_validator(mode="after")
    def _ga_at_registration(self) -> "MotherIn":
        ga = ga_days(self.lmp_date, ist_date(self.registered_at))
        if not 0 <= ga <= GA_AT_REGISTRATION_MAX:
            raise _model_error(
                "lmp_date",
                f"gestational age at registration must be 0-{GA_AT_REGISTRATION_MAX} days",
            )
        return self


class VisitIn(BaseModel):
    """``visit/create`` data. ``visit_date`` against the mother's LMP and today + 1
    is checked at apply time (Req 11.9)."""

    model_config = ConfigDict(extra="ignore")

    id: UuidStr
    mother_id: UuidStr
    visit_date: IsoDate
    weight_kg: Optional[WeightKg] = None
    weight_source: Optional[WeightSourceLit] = None
    ble_raw_hex: Optional[BleHexStr] = None
    hb_gdl: Optional[HbGdl] = None
    hb_source: Optional[HbSourceLit] = None
    bp_systolic: Optional[SystolicInt] = None
    bp_diastolic: Optional[DiastolicInt] = None
    bp_source: Optional[BpSourceLit] = None
    ifa_tablets: Optional[TabletsInt] = None
    calcium_tablets: Optional[TabletsInt] = None
    thr_received: Optional[StrictBool] = None
    notes: Optional[NotesStr] = None
    client_created_at: ClientDatetime

    @model_validator(mode="after")
    def _cross_field(self) -> "VisitIn":
        if self.weight_kg is not None and self.weight_source is None:
            raise _model_error("weight_source", "required when weight_kg is present")
        if self.hb_gdl is not None and self.hb_source is None:
            raise _model_error("hb_source", "required when hb_gdl is present")
        has_sys = self.bp_systolic is not None
        has_dia = self.bp_diastolic is not None
        if has_sys != has_dia:
            raise _model_error(
                "bp_systolic", "bp_systolic and bp_diastolic must be both present or both absent"
            )
        if has_sys and has_dia:
            if self.bp_systolic <= self.bp_diastolic:  # type: ignore[operator]
                raise _model_error("bp_systolic", "must be greater than bp_diastolic")
            if self.bp_source is None:
                raise _model_error("bp_source", "required when blood pressure is present")
        return self


class TaskCompleteIn(BaseModel):
    """``task/complete`` data."""

    model_config = ConfigDict(extra="ignore")

    id: UuidStr
    done_at: ClientDatetime
    done_note: Optional[DoneNoteStr] = None


# --------------------------------------------------------------------------- doctor actions

# Action presets (Req 23.1). English labels live in ``notifications.ACTION_LABELS_EN``
# (used in SMS text); Hindi labels live in the web app's i18n dictionary.
ACTION_TYPES: Tuple[str, ...] = (
    "HOME_VISIT_48H",
    "REFER_PHC",
    "IFA_PER_PROTOCOL",
    "REPEAT_HB",
    "BP_RECHECK",
    "ENSURE_THR",
    "DIET_COUNSEL",
    "OTHER",
)
ActionTypeLit = Literal[
    "HOME_VISIT_48H",
    "REFER_PHC",
    "IFA_PER_PROTOCOL",
    "REPEAT_HB",
    "BP_RECHECK",
    "ENSURE_THR",
    "DIET_COUNSEL",
    "OTHER",
]
INSTRUCTIONS_MAX = 500
TASK_DUE_MAX_DAYS = 60

InstructionsStr = Annotated[
    StrictStr, StringConstraints(strip_whitespace=True, max_length=INSTRUCTIONS_MAX)
]


class TaskCreateIn(BaseModel):
    """``POST /api/mothers/{id}/tasks`` body (Req 23.2–23.5).

    Field rules run here (FastAPI default 422 on failure). The due-date window
    (today to today + 60, IST) depends on the clock and the alert rules depend on
    the database, so ``task_service.create_task`` checks those.
    """

    model_config = ConfigDict(extra="ignore")

    action_type: ActionTypeLit
    instructions: Optional[InstructionsStr] = None
    due_date: IsoDate
    alert_id: Optional[UuidStr] = None

    @field_validator("instructions")
    @classmethod
    def _blank_instructions_to_none(cls, value: Optional[str]) -> Optional[str]:
        return value or None

    @model_validator(mode="after")
    def _other_needs_instructions(self) -> "TaskCreateIn":
        if self.action_type == "OTHER" and not self.instructions:
            raise _model_error("instructions", "required when action_type is OTHER")
        return self


# --------------------------------------------------------------------------- birth outcomes

BIRTH_WEIGHT_MIN, BIRTH_WEIGHT_MAX = 0.3, 6.0
DELIVERY_MIN_GA_DAYS = 140  # delivery_date >= lmp + 140 days (Req 24.2)

BirthOutcomeLit = Literal["live_birth", "stillbirth"]
BirthWeightKg = Annotated[
    float,
    Field(strict=True, ge=BIRTH_WEIGHT_MIN, le=BIRTH_WEIGHT_MAX, allow_inf_nan=False),
]


class BirthOutcomeIn(BaseModel):
    """``POST /api/mothers/{id}/birth-outcome`` body (Req 24.2, 24.3).

    The weight rules run here (FastAPI default 422): 0.3-6.0 kg when present, and
    required for ``live_birth``. The ``delivery_date`` window (LMP + 140 days to
    today, IST) depends on the clock and the mother, so
    ``outcome_service.record`` checks it (422 ``VALIDATION_ERROR``).
    """

    model_config = ConfigDict(extra="ignore")

    delivery_date: IsoDate
    outcome: BirthOutcomeLit
    birth_weight_kg: Optional[BirthWeightKg] = None

    @model_validator(mode="after")
    def _live_birth_needs_weight(self) -> "BirthOutcomeIn":
        if self.outcome == "live_birth" and self.birth_weight_kg is None:
            raise _model_error("birth_weight_kg", "required when outcome is live_birth")
        return self


# --------------------------------------------------------------------------- envelope


class ErrorBody(BaseModel):
    code: str
    message: str


class ChangeIn(BaseModel):
    """One push change. ``data`` is validated later, per change, by the entity model,
    so one malformed change cannot block the rest of the outbox."""

    model_config = ConfigDict(extra="ignore")

    entity: StrictStr
    op: StrictStr
    data: Dict[str, Any]


class PushIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    device_id: UuidStr
    changes: Annotated[List[ChangeIn], Field(min_length=1, max_length=200)]


ChangeStatus = Literal["applied", "duplicate", "stale", "rejected"]


class ChangeResult(BaseModel):
    """``results[i]`` of a push. ``error`` is non-null iff ``status == "rejected"``."""

    entity: str
    id: Optional[str]
    status: ChangeStatus
    error: Optional[ErrorBody] = None

    @model_validator(mode="after")
    def _error_iff_rejected(self) -> "ChangeResult":
        if (self.status == "rejected") != (self.error is not None):
            raise ValueError("error must be set exactly when status is 'rejected'")
        return self

    @classmethod
    def ok(cls, entity: str, id: Optional[str], status: ChangeStatus) -> "ChangeResult":
        return cls(entity=entity, id=id, status=status, error=None)

    @classmethod
    def rejected(
        cls, entity: str, id: Optional[str], code: str, message: str
    ) -> "ChangeResult":
        return cls(
            entity=entity,
            id=id,
            status="rejected",
            error=ErrorBody(code=code, message=message),
        )


class PushOut(BaseModel):
    server_time: str
    results: List[ChangeResult]


def first_error_message(exc: ValidationError) -> str:
    """``"<loc>: <msg>"`` of the first error (just ``msg`` when ``loc`` is empty)."""
    errors = exc.errors(include_url=False)
    if not errors:
        return "Invalid data"
    first = errors[0]
    loc = ".".join(str(part) for part in first.get("loc", ()))
    msg = first.get("msg", "Invalid value")
    return f"{loc}: {msg}" if loc else msg


# --------------------------------------------------------------------------- output models

OutDatetime = Annotated[datetime, PlainSerializer(iso_z, return_type=str)]


class _OutModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class FlagOut(_OutModel):
    code: str
    severity: str
    reason: str
    first_seen_at: Optional[OutDatetime] = None


class MotherOut(_OutModel):
    id: str
    full_name: str
    age: int
    guardian_name: str
    village_id: str
    phone: Optional[str] = None
    lmp_date: date
    edd_date: date
    is_bpl: bool
    height_cm: Optional[float] = None
    first_weight_kg: Optional[float] = None
    registered_at: OutDatetime
    updated_at: OutDatetime
    status: str
    risk_level: str
    risk_updated_at: Optional[OutDatetime] = None
    flags: List[FlagOut] = Field(default_factory=list)

    @classmethod
    def from_model(cls, mother: Any, flags: Optional[List[Any]] = None) -> "MotherOut":
        """Serialize an ORM ``Mother`` with her active flags (or the given ones)."""
        if flags is None:
            flags = [f for f in mother.flags if f.active]
        # ORM ``Mother.flags`` holds the full history, so it is never read directly.
        fields = {name: getattr(mother, name) for name in cls.model_fields if name != "flags"}
        return cls(**fields, flags=[FlagOut.model_validate(f) for f in flags])


class VisitOut(_OutModel):
    id: str
    mother_id: str
    visit_date: date
    weight_kg: Optional[float] = None
    weight_source: Optional[str] = None
    ble_raw_hex: Optional[str] = None
    hb_gdl: Optional[float] = None
    hb_source: Optional[str] = None
    bp_systolic: Optional[int] = None
    bp_diastolic: Optional[int] = None
    bp_source: Optional[str] = None
    ifa_tablets: Optional[int] = None
    calcium_tablets: Optional[int] = None
    thr_received: Optional[bool] = None
    notes: Optional[str] = None
    client_created_at: OutDatetime
    recorded_by_id: str
    device_id: Optional[str] = None
    received_at: OutDatetime


class TaskOut(_OutModel):
    id: str
    mother_id: str
    alert_id: Optional[str] = None
    action_type: str
    instructions: Optional[str] = None
    due_date: date
    status: str
    is_overdue: bool
    issued_by_id: str
    issued_by_name: Optional[str] = None
    asha_id: str
    created_at: OutDatetime
    done_at: Optional[OutDatetime] = None
    done_note: Optional[str] = None

    @classmethod
    def from_model(cls, task: Any, today: date) -> "TaskOut":
        """Serialize an ORM ``Task``; ``is_overdue`` uses the IST ``today`` (Req 12.10)."""
        issuer = getattr(task, "issued_by", None)
        return cls(
            id=task.id,
            mother_id=task.mother_id,
            alert_id=task.alert_id,
            action_type=task.action_type,
            instructions=task.instructions,
            due_date=task.due_date,
            status=task.status,
            is_overdue=task.status == "open" and task.due_date < today,
            issued_by_id=task.issued_by_id,
            issued_by_name=issuer.full_name if issuer is not None else None,
            asha_id=task.asha_id,
            created_at=task.created_at,
            done_at=task.done_at,
            done_note=task.done_note,
        )


class TaskListOut(TaskOut):
    """``GET /api/tasks`` row: ``TaskOut`` plus the mother's name and village, so the
    dashboard can list tasks without one detail request per row."""

    mother_name: Optional[str] = None
    village_name: Optional[str] = None

    @classmethod
    def from_model(cls, task: Any, today: date) -> "TaskListOut":  # type: ignore[override]
        base = dict(TaskOut.from_model(task, today))  # raw field values, not serialized
        mother = getattr(task, "mother", None)
        village = getattr(mother, "village", None) if mother is not None else None
        return cls(
            **base,
            mother_name=mother.full_name if mother is not None else None,
            village_name=village.name if village is not None else None,
        )


class BirthOutcomeOut(_OutModel):
    id: str
    mother_id: str
    delivery_date: date
    outcome: str
    birth_weight_kg: Optional[float] = None
    is_lbw: bool
    recorded_by_id: str
    created_at: OutDatetime


class OutcomesOut(BaseModel):
    """``GET /api/outcomes`` facility counts (Req 24.6)."""

    hb_improved_after_action: int
    mothers_with_action_and_followup_hb: int
    births_recorded: int
    lbw_count: int
    live_births: int


class VillageOut(_OutModel):
    id: str
    name: str
    lat: float
    lng: float


class FacilityRefOut(BaseModel):
    id: str
    name: str


class TrimesterCountsOut(BaseModel):
    t1: int = 0
    t2: int = 0
    t3: int = 0


class RiskCountsOut(BaseModel):
    red: int = 0
    amber: int = 0
    green: int = 0


class CensusVillageOut(BaseModel):
    """One village row of the census (Req 20.1), with coordinates for the map."""

    id: str
    name: str
    lat: float
    lng: float
    pregnant: int = 0
    bpl: int = 0
    red: int = 0
    amber: int = 0
    green: int = 0
    due_this_month: int = 0


class CensusOut(BaseModel):
    """``GET /api/dashboard/census`` (Req 20.1). Counts cover active mothers only."""

    facility: FacilityRefOut
    as_of: date
    total_pregnant: int
    bpl_count: int
    by_trimester: TrimesterCountsOut
    due_this_month: int
    risk_counts: RiskCountsOut
    villages: List[CensusVillageOut]


class QueueRowOut(BaseModel):
    """``GET /api/dashboard/queue`` row (Req 21.1). ``open_alert_id`` and
    ``open_alert_status`` describe the mother's live RED alert, or are null."""

    mother_id: str
    full_name: str
    guardian_name: str
    village_id: str
    village_name: str
    is_bpl: bool
    ga_days: int
    edd_date: date
    risk_level: str
    flags: List[FlagOut] = Field(default_factory=list)
    last_visit_date: Optional[date] = None
    open_alert_id: Optional[str] = None
    open_alert_status: Optional[str] = None
    open_task_count: int = 0
    risk_updated_at: Optional[OutDatetime] = None


class FlagHistoryOut(_OutModel):
    """A RiskFlag row, active or resolved, for the patient flag history."""

    id: str
    code: str
    severity: str
    reason: str
    active: bool
    source_visit_id: Optional[str] = None
    first_seen_at: OutDatetime
    last_evaluated_at: OutDatetime
    resolved_at: Optional[OutDatetime] = None


class UserRefOut(BaseModel):
    id: str
    full_name: str


class MotherDetailOut(BaseModel):
    """``GET /api/mothers/{id}`` (Req 22.1). ``alerts`` items are ``AlertOut``
    dicts from ``alert_router.alert_out`` (RED and AMBER, newest first)."""

    mother: MotherOut
    village: VillageOut
    asha: UserRefOut
    ga_days: int
    visits: List[VisitOut]
    flags_active: List[FlagOut]
    flags_history: List[FlagHistoryOut]
    tasks: List[TaskOut]
    alerts: List[Dict[str, Any]]
    birth_outcome: Optional[BirthOutcomeOut] = None


class PullOut(BaseModel):
    """``GET /api/sync/pull`` response (Req 12.5–12.9)."""

    cursor: str
    reset: bool
    server_time: str
    villages: List[VillageOut]
    mothers: List[MotherOut]
    visits: List[VisitOut]
    tasks: List[TaskOut]


__all__ = [
    "context_now",
    "normalize_uuid_or_none",
    "first_error_message",
    "UuidStr",
    "NameStr",
    "PhoneStr",
    "BleHexStr",
    "IsoDate",
    "ClientDatetime",
    "WeightKg",
    "HbGdl",
    "MotherIn",
    "VisitIn",
    "TaskCompleteIn",
    "ACTION_TYPES",
    "ActionTypeLit",
    "INSTRUCTIONS_MAX",
    "TASK_DUE_MAX_DAYS",
    "TaskCreateIn",
    "TaskListOut",
    "BIRTH_WEIGHT_MIN",
    "BIRTH_WEIGHT_MAX",
    "DELIVERY_MIN_GA_DAYS",
    "BirthOutcomeIn",
    "BirthOutcomeOut",
    "OutcomesOut",
    "ErrorBody",
    "ChangeIn",
    "PushIn",
    "ChangeResult",
    "PushOut",
    "FlagOut",
    "MotherOut",
    "VisitOut",
    "TaskOut",
    "VillageOut",
    "FacilityRefOut",
    "TrimesterCountsOut",
    "RiskCountsOut",
    "CensusVillageOut",
    "CensusOut",
    "QueueRowOut",
    "FlagHistoryOut",
    "UserRefOut",
    "MotherDetailOut",
    "PullOut",
]
