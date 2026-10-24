/**
 * Shared types for the two weight-scale readers (Req 33.11, 34.7, 35.3).
 *
 * Both the simulated scale and the Web Bluetooth reader turn raw 0x2A9D bytes
 * into a `ScaleReading` through the same `parseWeightMeasurement`, so the UI and
 * the saved visit (`weight_source`, `ble_raw_hex`) treat them identically.
 */
import type { MessageKey } from '../../shared/i18n';
import { WEIGHT_MAX, WEIGHT_MIN } from '../validation';
import { parseWeightMeasurement } from './weightScale';
import type { WeightParseResult } from './weightScale';

/** Matches the visit `weight_source` values for device readings. */
export type ScaleSource = 'ble' | 'simulated';

export interface ScaleReading {
  source: ScaleSource;
  /** Lowercase hex of the whole payload, no separators (stored as `ble_raw_hex`). */
  rawHex: string;
  result: WeightParseResult;
  /** Parsed kilograms, or null when the payload did not parse. */
  weightKg: number | null;
  /** True when the parsed weight is within 25–150 kg (Req 33.11). */
  plausible: boolean;
  receivedAt: Date;
}

/**
 * Reader lifecycle states:
 * - `idle`: not started, or stopped after an error
 * - `connecting`: chooser open / GATT connect in progress (BLE only)
 * - `waiting`: ready for a measurement
 * - `stabilizing`: simulated "Stabilizing…" delay
 * - `disconnected`: the device dropped the link (readings are kept)
 * - `stopped`: `stop()` was called
 */
export type ScaleStatus =
  | 'idle'
  | 'connecting'
  | 'waiting'
  | 'stabilizing'
  | 'disconnected'
  | 'stopped';

export interface ScaleReaderEvents {
  onReading?: (reading: ScaleReading) => void;
  onStatus?: (status: ScaleStatus) => void;
  /** A user-facing message key (fatal errors and the no-reading hint). */
  onError?: (key: MessageKey) => void;
  /** The user dismissed the device chooser; return to the visit silently. */
  onCancel?: () => void;
}

/** Common interface of the simulated and the Web Bluetooth scale readers. */
export interface ScaleReader {
  readonly source: ScaleSource;
  start(events: ScaleReaderEvents): Promise<void>;
  /** Idempotent. Releases every resource; never throws. */
  stop(): Promise<void>;
}

export function isPlausibleWeightKg(kg: number): boolean {
  return Number.isFinite(kg) && kg >= WEIGHT_MIN && kg <= WEIGHT_MAX;
}

function asView(bytes: DataView | Uint8Array): DataView {
  return bytes instanceof DataView
    ? bytes
    : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Parse one 0x2A9D payload into a reading. Pure. */
export function readingFromPayload(
  bytes: DataView | Uint8Array,
  source: ScaleSource,
  receivedAt: Date,
): ScaleReading {
  const result = parseWeightMeasurement(asView(bytes));
  const weightKg = result.ok ? result.weightKg : null;
  return {
    source,
    rawHex: result.rawHex,
    result,
    weightKg,
    plausible: weightKg !== null && isPlausibleWeightKg(weightKg),
    receivedAt,
  };
}

/** The latest reading that parsed successfully (Req 35.3), or null. */
export function latestSuccessful(readings: readonly ScaleReading[]): ScaleReading | null {
  for (let i = readings.length - 1; i >= 0; i--) {
    if (readings[i].result.ok) return readings[i];
  }
  return null;
}

/** A reading may be saved only when it parsed and is plausible. */
export function isUsableReading(r: ScaleReading | null): r is ScaleReading {
  return r !== null && r.result.ok && r.plausible;
}
