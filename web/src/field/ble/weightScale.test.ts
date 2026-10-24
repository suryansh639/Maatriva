/**
 * Weight Measurement (0x2A9D) parser vectors and encoder round-trip properties.
 *
 * **Validates: Requirements 33.1, 33.2, 33.3, 33.10, 34.1, 34.2, 34.3, 34.4, 34.5, 44.6**
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fromHex } from './hex';
import { round2 } from './round';
import { parseWeightMeasurement, type WeightParseOk, type WeightParseResult } from './weightScale';
import { encodeWeightMeasurement, type WeightMeasurementInput } from './weightScaleEncode';

const parseHex = (hex: string): WeightParseResult => {
  const bytes = fromHex(hex);
  return parseWeightMeasurement(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
};

const parseBytes = (bytes: Uint8Array): WeightParseResult =>
  parseWeightMeasurement(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));

function expectOk(r: WeightParseResult): WeightParseOk {
  if (!r.ok) throw new Error(`expected ok, got ${r.error} for ${r.rawHex}`);
  return r;
}

/** The 0.01 kg grid of Requirement 34.4. */
const gridWeight = (i: number): number => round2(25 + (i * 125) / 199);

describe('parseWeightMeasurement – Requirement 33.10 vectors', () => {
  it('00 38 2c → 56.60 kg', () => {
    const r = expectOk(parseHex('00 38 2c'));
    expect(r.unit).toBe('kg');
    expect(r.weightKg).toBe(56.6);
    expect(r.timestamp).toBeNull();
    expect(r.userId).toBeNull();
    expect(r.bmi).toBeNull();
    expect(r.heightM).toBeNull();
    expect(r.rawHex).toBe('00382c');
  });

  it('06 38 2c e9 07 01 0f 0a 1e 00 01 → 56.60 kg, 2025-01-15 10:30:00, user 1', () => {
    const r = expectOk(parseHex('06 38 2c e9 07 01 0f 0a 1e 00 01'));
    expect(r.weightKg).toBe(56.6);
    expect(r.timestamp?.getTime()).toBe(new Date(2025, 0, 15, 10, 30, 0).getTime());
    expect(r.userId).toBe(1);
    expect(r.rawHex).toBe('06382ce907010f0a1e0001');
  });

  it('01 98 3a → 150.00 lb, 68.04 kg', () => {
    const r = expectOk(parseHex('01 98 3a'));
    expect(r.unit).toBe('lb');
    expect(r.rawWeight * 0.01).toBe(150);
    expect(r.weightKg).toBe(68.04);
  });

  it('08 b0 36 f2 00 a4 06 → 70.00 kg, BMI 24.2, height 1.700 m', () => {
    const r = expectOk(parseHex('08 b0 36 f2 00 a4 06'));
    expect(r.weightKg).toBe(70);
    expect(r.bmi).toBe(24.2);
    expect(r.heightM).toBe(1.7);
  });

  it('00 ff ff → MEASUREMENT_UNSUCCESSFUL', () => {
    expect(parseHex('00 ff ff')).toEqual({ ok: false, error: 'MEASUREMENT_UNSUCCESSFUL', rawHex: '00ffff' });
  });

  it('02 38 2c e9 → TRUNCATED', () => {
    expect(parseHex('02 38 2c e9')).toEqual({ ok: false, error: 'TRUNCATED', rawHex: '02382ce9' });
  });

  it('00 38 → TOO_SHORT', () => {
    expect(parseHex('00 38')).toEqual({ ok: false, error: 'TOO_SHORT', rawHex: '0038' });
  });
});

describe('parseWeightMeasurement – error precedence and edge cases', () => {
  it('TRUNCATED takes precedence over MEASUREMENT_UNSUCCESSFUL (02 ff ff e9)', () => {
    const r = parseHex('02 ff ff e9');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('TRUNCATED');
  });

  it('TOO_SHORT takes precedence over TRUNCATED (0e ff)', () => {
    const r = parseHex('0e ff');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('TOO_SHORT');
  });

  it('ignores trailing bytes but keeps them in rawHex', () => {
    const r = expectOk(parseHex('00 38 2c aa bb'));
    expect(r.weightKg).toBe(56.6);
    expect(r.rawHex).toBe('00382caabb');
  });

  it('ignores reserved flag bits 4–7', () => {
    expect(expectOk(parseHex('f0 38 2c')).weightKg).toBe(56.6);
  });

  it('nulls an invalid timestamp (month 13) and unknown user 0xFF while parsing the rest', () => {
    const r = expectOk(parseHex('06 38 2c e9 07 0d 0f 0a 1e 00 ff'));
    expect(r.timestamp).toBeNull();
    expect(r.userId).toBeNull();
    expect(r.weightKg).toBe(56.6);
  });

  it('encoder writes 0xFFFF for an unsuccessful measurement', () => {
    const r = parseBytes(encodeWeightMeasurement({ weightKg: 60, unsuccessful: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('MEASUREMENT_UNSUCCESSFUL');
  });
});

describe('encodeWeightMeasurement – BMI/height pairing', () => {
  it('throws BMI_HEIGHT_PAIR when only BMI is given', () => {
    expect(() => encodeWeightMeasurement({ weightKg: 60, bmi: 22.5 })).toThrow('BMI_HEIGHT_PAIR');
  });

  it('throws BMI_HEIGHT_PAIR when only height is given', () => {
    expect(() => encodeWeightMeasurement({ weightKg: 60, heightM: 1.6 })).toThrow('BMI_HEIGHT_PAIR');
  });

  it('encodes the Requirement 33.10 BMI vector exactly', () => {
    const bytes = encodeWeightMeasurement({ weightKg: 70, bmi: 24.2, heightM: 1.7 });
    expect(Array.from(bytes)).toEqual(Array.from(fromHex('08 b0 36 f2 00 a4 06')));
  });
});

// Feature: maatriva-mvp, Property 1: Weight measurement round trip on the 0.01 kg grid
describe('Property 1: Weight measurement round trip on the 0.01 kg grid', () => {
  it.each(['kg', 'lb'] as const)('all 200 grid points decode exactly (%s)', (unit) => {
    for (let i = 0; i < 200; i++) {
      const w = gridWeight(i);
      const r = expectOk(parseBytes(encodeWeightMeasurement({ weightKg: w, unit })));
      expect(r.unit).toBe(unit);
      expect(Math.abs(r.weightKg - w)).toBeLessThanOrEqual(1e-9);
    }
  });

  /** Valid local-time components; day ≤ 28 so every month accepts it. */
  const timestampArb = fc
    .record({
      year: fc.integer({ min: 1, max: 9999 }),
      month: fc.integer({ min: 1, max: 12 }),
      day: fc.integer({ min: 1, max: 28 }),
      hours: fc.integer({ min: 0, max: 23 }),
      minutes: fc.integer({ min: 0, max: 59 }),
      seconds: fc.integer({ min: 0, max: 59 }),
    })
    .map(({ year, month, day, hours, minutes, seconds }) => {
      const d = new Date(2000, 0, 1, hours, minutes, seconds, 0);
      d.setFullYear(year, month - 1, day);
      return d;
    });

  const caseArb = fc.record({
    i: fc.integer({ min: 0, max: 199 }),
    unit: fc.constantFrom('kg' as const, 'lb' as const),
    timestamp: fc.option(timestampArb, { nil: undefined }),
    userId: fc.option(fc.integer({ min: 0, max: 254 }), { nil: undefined }),
    bmiHeight: fc.option(
      fc.record({ bmiK: fc.integer({ min: 0, max: 0xffff }), heightK: fc.integer({ min: 0, max: 0xffff }) }),
      { nil: undefined },
    ),
  });

  it('optional timestamp, user ID and BMI/height round-trip exactly in SI and imperial', () => {
    fc.assert(
      fc.property(caseArb, ({ i, unit, timestamp, userId, bmiHeight }) => {
        const w = gridWeight(i);
        // BMI and height drawn on their wire grids.
        const bmi = bmiHeight ? bmiHeight.bmiK / 10 : undefined;
        const heightM = bmiHeight
          ? unit === 'lb'
            ? Math.round(bmiHeight.heightK * 2.54) / 1000
            : bmiHeight.heightK / 1000
          : undefined;
        const m: WeightMeasurementInput = { weightKg: w, unit, timestamp, userId, bmi, heightM };

        const r = expectOk(parseBytes(encodeWeightMeasurement(m)));
        expect(r.unit).toBe(unit);
        expect(Math.abs(r.weightKg - w)).toBeLessThanOrEqual(1e-9);
        expect(r.timestamp === null ? null : r.timestamp.getTime()).toBe(timestamp ? timestamp.getTime() : null);
        expect(r.userId).toBe(userId ?? null);
        expect(r.bmi).toBe(bmi ?? null);
        expect(r.heightM).toBe(heightM ?? null);
      }),
      { numRuns: 500 },
    );
  });
});

// Feature: maatriva-mvp, Property 2: Off-grid weight round-trip tolerance
describe('Property 2: Off-grid weight round-trip tolerance', () => {
  it('any weight in [25, 150] kg decodes within 0.0075 kg in both units', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 25, max: 150, noNaN: true, noDefaultInfinity: true }),
        fc.constantFrom('kg' as const, 'lb' as const),
        (x, unit) => {
          const r = expectOk(parseBytes(encodeWeightMeasurement({ weightKg: x, unit })));
          expect(Math.abs(r.weightKg - x)).toBeLessThanOrEqual(0.0075 + 1e-9);
        },
      ),
      { numRuns: 1000 },
    );
  });
});
