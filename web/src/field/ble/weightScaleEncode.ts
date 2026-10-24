/**
 * Pure encoder for the Bluetooth Weight Measurement characteristic (0x2A9D).
 * Exact inverse of `parseWeightMeasurement` in `weightScale.ts`: the flags are
 * set from the supplied fields, and fields are written in wire order
 * (weight, timestamp, user ID, BMI + height).
 *
 * Round-trip guarantees (Req 34.4/34.5):
 *   - weights on the 0.01 kg grid decode exactly (SI step 0.005 kg, imperial
 *     step 0.01 lb ≈ 0.0045 kg, both finer than the 0.01 kg grid);
 *   - any weight in 25–150 kg decodes within 0.0075 kg
 *     (half a wire step + half a round2 step).
 */
import {
  FLAG_BMI_HEIGHT,
  FLAG_IMPERIAL,
  FLAG_TIMESTAMP,
  FLAG_USER_ID,
  LB_TO_KG,
  WEIGHT_UNSUCCESSFUL,
  expectedLength,
} from './weightScale';

/** Largest encodable weight; 0xFFFF is reserved for "measurement unsuccessful". */
export const RAW_WEIGHT_MAX = 0xfffe;
const UINT16_MAX = 0xffff;

export interface WeightMeasurementInput {
  /** Weight in kilograms (converted to 0.01 lb units when `unit` is 'lb'). */
  weightKg: number;
  /** Wire units; defaults to SI ('kg'). */
  unit?: 'kg' | 'lb';
  /** Write the 0xFFFF "measurement unsuccessful" sentinel instead of the weight. */
  unsuccessful?: boolean;
  /** Encoded from the Date's local components (scale-local time). */
  timestamp?: Date | null;
  /** 0–255; 0xFF means "unknown user" on the wire. */
  userId?: number | null;
  /** kg/m², 0.1 resolution. Must be supplied together with `heightM`. */
  bmi?: number | null;
  /** Metres: 0.001 m resolution (SI) or 0.1 in resolution (imperial). */
  heightM?: number | null;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** Raw uint16 weight for the given unit, clamped to 0..0xFFFE. */
export function rawWeightFor(weightKg: number, imperial: boolean): number {
  const raw = imperial ? Math.round(weightKg / LB_TO_KG / 0.01) : Math.round(weightKg / 0.005);
  return clamp(raw, 0, RAW_WEIGHT_MAX);
}

/** Raw uint16 height: 0.001 m (SI) or 0.1 in (imperial). */
function rawHeightFor(heightM: number, imperial: boolean): number {
  // Imperial inverts the parser's Math.round(raw * 2.54) / 1000: round to whole mm
  // first so float noise in heightM * 1000 cannot shift the result.
  const mm = Math.round(heightM * 1000);
  return clamp(imperial ? Math.round(mm / 2.54) : mm, 0, UINT16_MAX);
}

export function encodeWeightMeasurement(m: WeightMeasurementInput): Uint8Array {
  const hasBmi = m.bmi !== undefined && m.bmi !== null;
  const hasHeight = m.heightM !== undefined && m.heightM !== null;
  if (hasBmi !== hasHeight) throw new Error('BMI_HEIGHT_PAIR');

  const imperial = m.unit === 'lb';
  const hasTimestamp = m.timestamp instanceof Date;
  const hasUserId = m.userId !== undefined && m.userId !== null;

  const flags =
    (imperial ? FLAG_IMPERIAL : 0) |
    (hasTimestamp ? FLAG_TIMESTAMP : 0) |
    (hasUserId ? FLAG_USER_ID : 0) |
    (hasBmi ? FLAG_BMI_HEIGHT : 0);

  const out = new Uint8Array(expectedLength(flags));
  const view = new DataView(out.buffer);
  view.setUint8(0, flags);
  view.setUint16(1, m.unsuccessful ? WEIGHT_UNSUCCESSFUL : rawWeightFor(m.weightKg, imperial), true);

  let offset = 3;
  if (hasTimestamp) {
    const t = m.timestamp as Date;
    view.setUint16(offset, clamp(t.getFullYear(), 0, UINT16_MAX), true);
    view.setUint8(offset + 2, t.getMonth() + 1);
    view.setUint8(offset + 3, t.getDate());
    view.setUint8(offset + 4, t.getHours());
    view.setUint8(offset + 5, t.getMinutes());
    view.setUint8(offset + 6, t.getSeconds());
    offset += 7;
  }

  if (hasUserId) {
    view.setUint8(offset, clamp(Math.round(m.userId as number), 0, 0xff));
    offset += 1;
  }

  if (hasBmi) {
    view.setUint16(offset, clamp(Math.round((m.bmi as number) * 10), 0, UINT16_MAX), true);
    view.setUint16(offset + 2, rawHeightFor(m.heightM as number, imperial), true);
    offset += 4;
  }

  return out;
}
