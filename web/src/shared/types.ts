/**
 * Wire types mirroring the backend output and input models (backend/app/schemas.py,
 * alert_router.alert_out, deps.CurrentUser.to_out and the router dict responses).
 *
 * Conventions: dates are IST calendar dates as "YYYY-MM-DD"; datetimes are UTC
 * ISO-8601 strings with a "Z" suffix (backend `iso_z`).
 */

export type IsoDate = string;
export type IsoDateTime = string;

export type Role = 'asha' | 'anm' | 'doctor' | 'admin';
export type RiskLevel = 'RED' | 'AMBER' | 'GREEN';
export type Severity = 'RED' | 'AMBER';
export type MotherStatus = 'active' | 'delivered';
export type TaskStatus = 'open' | 'done' | 'cancelled';
export type AlertStatus = 'open' | 'acknowledged' | 'actioned' | 'closed';
export type RecipientRole = 'doctor' | 'anm';
export type WeightSource = 'manual' | 'ble' | 'simulated';
export type HbSource = 'manual' | 'device';
export type BpSource = 'manual' | 'ble' | 'simulated';
export type BirthOutcomeKind = 'live_birth' | 'stillbirth';
export type NotificationKind = 'red_alert' | 'task_assigned' | 'amber_digest' | 'task_done';

export type FlagCode =
  | 'HB_SEVERE'
  | 'HB_MODERATE'
  | 'HB_MILD'
  | 'BP_SEVERE'
  | 'BP_HIGH'
  | 'WEIGHT_LOSS'
  | 'WEIGHT_STATIC'
  | 'WEIGHT_GAIN_LOW'
  | 'BMI_LOW'
  | 'LATE_REG'
  | 'VISIT_OVERDUE';

/** Action presets (Req 23.1), same order as `schemas.ACTION_TYPES`. */
export const ACTION_TYPES = [
  'HOME_VISIT_48H',
  'REFER_PHC',
  'IFA_PER_PROTOCOL',
  'REPEAT_HB',
  'BP_RECHECK',
  'ENSURE_THR',
  'DIET_COUNSEL',
  'OTHER',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

// ------------------------------------------------------------------ errors

export interface ErrorBody {
  code: string;
  message: string;
}

// ------------------------------------------------------------------ auth

/** `CurrentUser.to_out()`: login and `GET /api/me` (Req 5.3, 5.9). */
export interface UserOut {
  id: string;
  username: string;
  full_name: string;
  role: Role;
  facility_id: string | null;
  facility_name: string | null;
  village_ids: string[];
}

export interface LoginResponse {
  access_token: string;
  token_type: 'bearer';
  expires_at: IsoDateTime;
  user: UserOut;
}

// ------------------------------------------------------------------ core rows

export interface FlagOut {
  code: FlagCode | string;
  severity: Severity | string;
  reason: string;
  first_seen_at?: IsoDateTime | null;
}

export interface VillageOut {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export interface MotherOut {
  id: string;
  full_name: string;
  age: number;
  guardian_name: string;
  village_id: string;
  phone: string | null;
  lmp_date: IsoDate;
  edd_date: IsoDate;
  is_bpl: boolean;
  height_cm: number | null;
  first_weight_kg: number | null;
  registered_at: IsoDateTime;
  updated_at: IsoDateTime;
  status: MotherStatus;
  risk_level: RiskLevel;
  risk_updated_at: IsoDateTime | null;
  flags: FlagOut[];
}

export interface VisitOut {
  id: string;
  mother_id: string;
  visit_date: IsoDate;
  weight_kg: number | null;
  weight_source: WeightSource | null;
  ble_raw_hex: string | null;
  hb_gdl: number | null;
  hb_source: HbSource | null;
  bp_systolic: number | null;
  bp_diastolic: number | null;
  bp_source: BpSource | null;
  ifa_tablets: number | null;
  calcium_tablets: number | null;
  thr_received: boolean | null;
  notes: string | null;
  client_created_at: IsoDateTime;
  recorded_by_id: string;
  device_id: string | null;
  received_at: IsoDateTime;
}

/** The 14 fields of Req 12.9. */
export interface TaskOut {
  id: string;
  mother_id: string;
  alert_id: string | null;
  action_type: ActionType | string;
  instructions: string | null;
  due_date: IsoDate;
  status: TaskStatus;
  is_overdue: boolean;
  issued_by_id: string;
  issued_by_name: string | null;
  asha_id: string;
  created_at: IsoDateTime;
  done_at: IsoDateTime | null;
  done_note: string | null;
}

/** `GET /api/tasks` row. */
export interface TaskListOut extends TaskOut {
  mother_name: string | null;
  village_name: string | null;
}

/** `alert_router.alert_out`. */
export interface AlertOut {
  id: string;
  mother_id: string;
  mother_name: string | null;
  village_name: string | null;
  recipient_role: RecipientRole;
  severity: Severity;
  status: AlertStatus;
  flag_codes: string[];
  summary: string;
  reasons: string[];
  created_at: IsoDateTime;
  updated_at: IsoDateTime | null;
  acknowledged_at: IsoDateTime | null;
  closed_at: IsoDateTime | null;
}

export interface BirthOutcomeOut {
  id: string;
  mother_id: string;
  delivery_date: IsoDate;
  outcome: BirthOutcomeKind;
  birth_weight_kg: number | null;
  is_lbw: boolean;
  recorded_by_id: string;
  created_at: IsoDateTime;
}

export interface FlagHistoryOut {
  id: string;
  code: string;
  severity: Severity | string;
  reason: string;
  active: boolean;
  source_visit_id: string | null;
  first_seen_at: IsoDateTime;
  last_evaluated_at: IsoDateTime;
  resolved_at: IsoDateTime | null;
}

export interface UserRefOut {
  id: string;
  full_name: string;
}

// ------------------------------------------------------------------ sync

/** `mother/upsert` data (`MotherIn`); server-owned fields are not sent. */
export interface MotherIn {
  id: string;
  full_name: string;
  age: number;
  guardian_name: string;
  village_id: string;
  phone?: string | null;
  lmp_date: IsoDate;
  is_bpl: boolean;
  height_cm?: number | null;
  first_weight_kg?: number | null;
  registered_at: IsoDateTime;
  updated_at: IsoDateTime;
}

/** `visit/create` data (`VisitIn`). */
export interface VisitIn {
  id: string;
  mother_id: string;
  visit_date: IsoDate;
  weight_kg?: number | null;
  weight_source?: WeightSource | null;
  ble_raw_hex?: string | null;
  hb_gdl?: number | null;
  hb_source?: HbSource | null;
  bp_systolic?: number | null;
  bp_diastolic?: number | null;
  bp_source?: BpSource | null;
  ifa_tablets?: number | null;
  calcium_tablets?: number | null;
  thr_received?: boolean | null;
  notes?: string | null;
  client_created_at: IsoDateTime;
}

/** `task/complete` data (`TaskCompleteIn`). */
export interface TaskCompleteIn {
  id: string;
  done_at: IsoDateTime;
  done_note?: string | null;
}

export type ChangeIn =
  | { entity: 'mother'; op: 'upsert'; data: MotherIn }
  | { entity: 'visit'; op: 'create'; data: VisitIn }
  | { entity: 'task'; op: 'complete'; data: TaskCompleteIn };

export type SyncEntity = ChangeIn['entity'];

export interface PushRequest {
  device_id: string;
  changes: ChangeIn[];
}

export type ChangeStatus = 'applied' | 'duplicate' | 'stale' | 'rejected';

/** `results[i]`; `error` is non-null iff `status === 'rejected'`. */
export interface ChangeResult {
  entity: string;
  id: string | null;
  status: ChangeStatus;
  error: ErrorBody | null;
}

export interface PushResponse {
  server_time: IsoDateTime;
  results: ChangeResult[];
}

export interface PullResponse {
  cursor: string;
  reset: boolean;
  server_time: IsoDateTime;
  villages: VillageOut[];
  mothers: MotherOut[];
  visits: VisitOut[];
  tasks: TaskOut[];
}

// ------------------------------------------------------------------ local (Dexie) rows

/**
 * A mother as stored on the device. `risk_level`, `edd_date`, `status` and the
 * other server-owned fields stay null until the first pull returns her.
 */
export interface LocalMother extends Omit<MotherOut, 'risk_level' | 'edd_date' | 'status' | 'risk_updated_at' | 'flags'> {
  risk_level: RiskLevel | null;
  risk_updated_at: IsoDateTime | null;
  edd_date: IsoDate | null;
  status: MotherStatus | null;
  flags: FlagOut[];
  pending?: boolean;
}

/** A visit as stored on the device; server fields are null until pulled. */
export interface LocalVisit extends Omit<VisitOut, 'recorded_by_id' | 'received_at'> {
  recorded_by_id: string | null;
  received_at: IsoDateTime | null;
  pending?: boolean;
}

// ------------------------------------------------------------------ dashboard

export interface FacilityRefOut {
  id: string;
  name: string;
}

export interface CensusVillageOut {
  id: string;
  name: string;
  lat: number;
  lng: number;
  pregnant: number;
  bpl: number;
  red: number;
  amber: number;
  green: number;
  due_this_month: number;
}

export interface CensusOut {
  facility: FacilityRefOut;
  as_of: IsoDate;
  total_pregnant: number;
  bpl_count: number;
  by_trimester: { t1: number; t2: number; t3: number };
  due_this_month: number;
  risk_counts: { red: number; amber: number; green: number };
  villages: CensusVillageOut[];
}

export interface QueueRowOut {
  mother_id: string;
  full_name: string;
  guardian_name: string;
  village_id: string;
  village_name: string;
  is_bpl: boolean;
  ga_days: number;
  edd_date: IsoDate;
  risk_level: RiskLevel;
  flags: FlagOut[];
  last_visit_date: IsoDate | null;
  open_alert_id: string | null;
  open_alert_status: AlertStatus | null;
  open_task_count: number;
  risk_updated_at: IsoDateTime | null;
}

export interface MotherDetailOut {
  mother: MotherOut;
  village: VillageOut;
  asha: UserRefOut;
  ga_days: number;
  visits: VisitOut[];
  flags_active: FlagOut[];
  flags_history: FlagHistoryOut[];
  tasks: TaskOut[];
  alerts: AlertOut[];
  birth_outcome: BirthOutcomeOut | null;
}

/** `POST /api/mothers/{id}/tasks` body (`TaskCreateIn`). */
export interface TaskCreateIn {
  action_type: ActionType;
  instructions?: string | null;
  due_date: IsoDate;
  alert_id?: string | null;
}

/** `POST /api/mothers/{id}/birth-outcome` body (`BirthOutcomeIn`). */
export interface BirthOutcomeIn {
  delivery_date: IsoDate;
  outcome: BirthOutcomeKind;
  birth_weight_kg?: number | null;
}

export interface OutcomesOut {
  hb_improved_after_action: number;
  mothers_with_action_and_followup_hb: number;
  births_recorded: number;
  lbw_count: number;
  live_births: number;
}

export interface DigestItemOut {
  alert_id: string;
  mother_id: string;
  mother_name: string;
  short_code: string;
  risk_level: RiskLevel;
  flag_codes: string[];
  reasons: string[];
  summary: string;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface DigestVillageOut {
  village_id: string;
  village_name: string;
  count: number;
  items: DigestItemOut[];
}

export interface DigestOut {
  as_of: IsoDateTime;
  since: IsoDateTime;
  total: number;
  villages: DigestVillageOut[];
}

export interface DigestSendOut {
  count: number;
}

export interface NotificationOut {
  id: string;
  channel: 'sms';
  kind: NotificationKind;
  status: 'mock_sent';
  to_user_id: string | null;
  to_username: string | null;
  to_role: Role | null;
  to_phone: string | null;
  body: string;
  related_alert_id: string | null;
  related_task_id: string | null;
  created_at: IsoDateTime;
}

export interface DemoTriggerRedOut {
  alert_id: string | null;
  mother_id: string;
  risk_level: RiskLevel;
}

export interface DemoResetOut {
  mother_id: string;
  risk_level: RiskLevel;
}

// ------------------------------------------------------------------ SSE events

export interface HelloEvent {
  server_time: IsoDateTime;
}

export interface AlertCreatedEvent {
  alert: AlertOut;
}

export interface AlertUpdatedEvent {
  alert: AlertOut;
  new_codes: string[];
}

export interface TaskDoneEvent {
  task: TaskOut;
  mother_name: string | null;
}

export interface RiskChangedEvent {
  mother_id: string;
  risk_level: RiskLevel;
}

export interface LiveEventMap {
  hello: HelloEvent;
  'alert.created': AlertCreatedEvent;
  'alert.updated': AlertUpdatedEvent;
  'task.done': TaskDoneEvent;
  'risk.changed': RiskChangedEvent;
}

export type LiveEventName = keyof LiveEventMap;
