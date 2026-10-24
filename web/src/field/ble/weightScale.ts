/**
 * Pure decoder for the Bluetooth Weight Measurement characteristic (0x2A9D,
 * Weight Scale Service 0x181D).
 *
 * Layout:
 *   byte 0     flags: bit0 imperial (lb/in), bit1 timestamp, bit2 user ID,
 *              bit3 BMI + height; bits 4-7 reserved (ignored)
 *   bytes 1-2  weight uint16 LE: SI 0.005 kg, imperial 0.01 lb; 0xFFFF = unsuccessful
 *   then, when flagged and in this order:
 *     timestamp 7 bytes (year u16 LE, month, day, hours, minutes, seconds)
 *     user ID   1 byte (0xFF = unknown)
 *     BMI       u16 LE, 0.1 kg/m^2
 *     height    u16 LE, 0.001 m (SI) or 0.1 in (imperial)
 *
 * Errors are checked in the order TOO_SHORT -> TRUNCATED -> MEASUREMENT_UNSUCCESSFUL.
 * Bytes beyond the expected length are ignored. Every result carries `rawHex`
 * (lowercase hex of the whole input, no separators).
 */
import { toHex } from './hex';
import { round2 } from './round';

export { round2 };

export const FLAG_IMPERIAL = 0x01;
export const FLAG_TIMESTAMP = 0x02;
export const FLAG_USER_ID = 0x04;
export const FLAG_BMI_HEIGHT = 0x08;

export const WEIGHT_UNSUCCESSFUL = 0xffff;
export const USER_ID_UNKNOWN = 0xff;
export const LB_TO_KG = 0.45359237;

export type WeightParseError = 'TOO_SHORT' | 'TRUNCATED' | 'MEASUREMENT_UNSUCCESSFUL';

export interface WeightParseOk {
  ok: true;
  unit: 'kg' | 'lb';
  rawWeight: number;
  weightKg: number;
  /** Scale-local time, or null when unknown/invalid. */
  timestamp: Date | null;
  userId: number | null;
  bmi: number | null;
  heightM: number | null;
  rawHex: string;
}

export interface WeightParseFailure {
  ok: false;
  error: WeightParseError;
  rawHex: string;
}

export type WeightParseResult = WeightParseOk | WeightParseFailure;

/** Expected payload length for a flags byte: 3 + 7·ts + 1·uid + 4·bmi. */
export function expectedLength(flags: number): number {
  return (
    3 +
    (flags & FLAG_TIMESTAMP ? 7 : 0) +
    (flags & FLAG_USER_ID ? 1 : 0) +
    (flags & FLAG_BMI_HEIGHT ? 4 : 0)
  );
}

function decodeTimestamp(view: DataView, offset: number): Date | null {
  const year = view.getUint16(offset, true);
  const month = view.getUint8(offset + 2);
  const day = view.getUint8(offset + 3);
  const hours = view.getUint8(offset + 4);
  const minutes = view.getUint8(offset + 5);
  const seconds = view.getUint8(offset + 6);
  if (year === 0 || month === 0 || day === 0) return null;
  if (month > 12 || day > 31 || hours > 23 || minutes > 59 || seconds > 59) return null;
  const d = new Date(2000, 0, 1, hours, minutes, seconds, 0);
  // setFullYear avoids the Date constructor's 0-99 -> 19xx year mapping.
  d.setFullYear(year, month - 1, day);
  return d;
}

export function parseWeightMeasurement(view: DataView): WeightParseResult {
  const rawHex = toHex(view);
  const len = view.byteLength;
  if (len < 3) return { ok: false, error: 'TOO_SHORT', rawHex };

  const flags = view.getUint8(0);
  if (len < expectedLength(flags)) return { ok: false, error: 'TRUNCATED', rawHex };

  const rawWeight = view.getUint16(1, true);
  if (rawWeight === WEIGHT_UNSUCCESSFUL) {
    return { ok: false, error: 'MEASUREMENT_UNSUCCESSFUL', rawHex };
  }

  const imperial = (flags & FLAG_IMPERIAL) !== 0;
  const weightKg = imperial ? round2(rawWeight * 0.01 * LB_TO_KG) : round2(rawWeight * 0.005);

  let offset = 3;
  let timestamp: Date | null = null;
  if (flags & FLAG_TIMESTAMP) {
    timestamp = decodeTimestamp(view, offset);
    offset += 7;
  }

  let userId: number | null = null;
  if (flags & FLAG_USER_ID) {
    const uid = view.getUint8(offset);
    userId = uid === USER_ID_UNKNOWN ? null : uid;
    offset += 1;
  }

  let bmi: number | null = null;
  let heightM: number | null = null;
  if (flags & FLAG_BMI_HEIGHT) {
    // Division (not multiplication) keeps results like 242 / 10 === 24.2 exact.
    bmi = view.getUint16(offset, true) / 10;
    const rawHeight = view.getUint16(offset + 2, true);
    // Imperial: 0.1 in = 2.54 mm, rounded to the mm.
    heightM = imperial ? Math.round(rawHeight * 2.54) / 1000 : rawHeight / 1000;
    offset += 4;
  }

  return {
    ok: true,
    unit: imperial ? 'lb' : 'kg',
    rawWeight,
    weightKg,
    timestamp,
    userId,
    bmi,
    heightM,
    rawHex,
  };
}
