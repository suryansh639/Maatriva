/**
 * Pure key handling for `NumericKeypad` (Req 30.1, 30.2).
 *
 * The on-screen keys edit the same text the `<input inputmode="decimal">` holds, so
 * typing and tapping behave alike. Range checks are the form's job
 * (`parseNumberInput` + `validateVisitDraft`); the keypad only stops input that can
 * never become a valid number: a second decimal point, digits past `maxDecimals`,
 * and text longer than `maxLength`.
 */

export type KeypadKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '.' | 'backspace' | 'clear';

export const KEYPAD_DIGITS: readonly KeypadKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

export interface KeypadLimits {
  /** Digits allowed after the decimal point (Hb: 1). */
  maxDecimals: number;
  /** Maximum text length, including the point (Hb "20.0": 4; default 5). */
  maxLength?: number;
}

/** The text after pressing `key` on a keypad showing `value`. */
export function applyKeypadKey(value: string, key: KeypadKey, limits: KeypadLimits): string {
  const maxLength = limits.maxLength ?? 5;
  if (key === 'clear') return '';
  if (key === 'backspace') return value.slice(0, -1);

  // Typed text may use "," as the decimal mark; treat it like ".".
  const normalized = value.replace(',', '.');
  const dot = normalized.indexOf('.');

  if (key === '.') {
    if (limits.maxDecimals <= 0 || dot !== -1) return value;
    const next = normalized === '' ? '0.' : `${normalized}.`;
    return next.length > maxLength ? value : next;
  }

  if (dot !== -1 && normalized.length - dot - 1 >= limits.maxDecimals) return value;
  if (normalized.length >= maxLength) return value;
  // Replace a lone leading zero ("0" + "6" → "6"), keep "0." prefixes.
  if (normalized === '0') return key;
  return `${normalized}${key}`;
}
