import { describe, expect, it, vi } from 'vitest';
import { fromHex } from './hex';
import { isUsableReading, latestSuccessful, readingFromPayload } from './scale';
import type { ScaleReading, ScaleStatus } from './scale';
import {
  DEMO_PRESET_KG,
  SimulatedScaleReader,
  defaultTargetKg,
  simulatedWeightKg,
} from './simulatedScale';
import { WebBluetoothScaleReader, isWebBluetoothAvailable } from './webBluetooth';
import type {
  BleCharacteristicLike,
  BleDeviceLike,
  BluetoothLike,
} from './webBluetooth';
import type { MessageKey } from '../../shared/i18n';

const AT = new Date(2025, 0, 15, 10, 30, 0);
const instantSleep = () => Promise.resolve();

describe('readingFromPayload', () => {
  it('parses a plausible SI payload', () => {
    const r = readingFromPayload(fromHex('00 38 2c'), 'ble', AT);
    expect(r.weightKg).toBe(56.6);
    expect(r.plausible).toBe(true);
    expect(r.rawHex).toBe('00382c');
    expect(isUsableReading(r)).toBe(true);
  });

  it('marks readings outside 25–150 kg as implausible', () => {
    // raw 4000 * 0.005 = 20 kg; raw 31000 * 0.005 = 155 kg
    for (const hex of ['00 a0 0f', '00 18 79']) {
      const r = readingFromPayload(fromHex(hex), 'ble', AT);
      expect(r.result.ok).toBe(true);
      expect(r.plausible).toBe(false);
      expect(isUsableReading(r)).toBe(false);
    }
  });

  it('keeps parse failures with their hex', () => {
    const r = readingFromPayload(fromHex('00 ff ff'), 'ble', AT);
    expect(r.weightKg).toBeNull();
    expect(r.result).toMatchObject({ ok: false, error: 'MEASUREMENT_UNSUCCESSFUL' });
    expect(r.rawHex).toBe('00ffff');
  });

  it('latestSuccessful skips failed payloads', () => {
    const ok = readingFromPayload(fromHex('00 38 2c'), 'ble', AT);
    const bad = readingFromPayload(fromHex('00 ff ff'), 'ble', AT);
    expect(latestSuccessful([ok, bad])).toBe(ok);
    expect(latestSuccessful([bad])).toBeNull();
  });
});

describe('simulated scale', () => {
  it('defaults the target to the last weight, else 55.0', () => {
    expect(defaultTargetKg(58)).toBe(58);
    expect(defaultTargetKg(null)).toBe(55);
    expect(defaultTargetKg(undefined)).toBe(55);
  });

  it('jitter is off by default and bounded to ±0.2 kg on the 0.01 grid', () => {
    expect(simulatedWeightKg(56.6, false, () => 0.99)).toBe(56.6);
    expect(simulatedWeightKg(56.6, true, () => 0)).toBe(56.4);
    expect(simulatedWeightKg(56.6, true, () => 0.5)).toBe(56.6);
    expect(simulatedWeightKg(56.6, true, () => 0.999999)).toBe(56.8);
  });

  it('demo preset emits flags 06, raw 11320, user 1 and the current time', async () => {
    const statuses: ScaleStatus[] = [];
    const readings: ScaleReading[] = [];
    const scale = new SimulatedScaleReader({ now: () => AT, sleep: instantSleep });
    await scale.start({ onStatus: (s) => statuses.push(s), onReading: (r) => readings.push(r) });
    const r = await scale.step(DEMO_PRESET_KG);

    expect(r).not.toBeNull();
    expect(r!.rawHex).toBe('06382ce907010f0a1e0001');
    expect(r!.weightKg).toBe(56.6);
    expect(r!.source).toBe('simulated');
    expect(r!.result).toMatchObject({ ok: true, userId: 1, timestamp: AT });
    expect(readings).toEqual([r]);
    expect(statuses).toEqual(['waiting', 'stabilizing', 'waiting']);
  });

  it('waits 1 s while stabilizing and stop() cancels the pending reading', async () => {
    vi.useFakeTimers();
    try {
      const onReading = vi.fn();
      const scale = new SimulatedScaleReader({ now: () => AT });
      await scale.start({ onReading });
      const pending = scale.step(56.6);
      await vi.advanceTimersByTimeAsync(999);
      expect(onReading).not.toHaveBeenCalled();
      await scale.stop();
      await vi.advanceTimersByTimeAsync(10);
      expect(await pending).toBeNull();
      expect(onReading).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// --------------------------------------------------------------------------- Web Bluetooth

function namedError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

interface FakeOptions {
  requestError?: Error;
  connectError?: Error;
  serviceError?: Error;
}

function fakeBluetooth(opts: FakeOptions = {}) {
  const valueListeners = new Set<(ev: Event) => void>();
  const calls: string[] = [];
  let connected = false;
  const characteristic: BleCharacteristicLike & { value: DataView | null } = {
    value: null,
    startNotifications: async () => {
      calls.push('startNotifications');
    },
    stopNotifications: async () => {
      calls.push('stopNotifications');
    },
    addEventListener: (_t, l) => valueListeners.add(l),
    removeEventListener: (_t, l) => valueListeners.delete(l),
  };
  const device: BleDeviceLike = {
    gatt: {
      get connected() {
        return connected;
      },
      connect: async () => {
        calls.push('connect');
        if (opts.connectError) throw opts.connectError;
        connected = true;
        return {
          connected: true,
          getPrimaryService: async (s: number) => {
            calls.push(`service:${s.toString(16)}`);
            if (opts.serviceError) throw opts.serviceError;
            return {
              getCharacteristic: async (c: number) => {
                calls.push(`characteristic:${c.toString(16)}`);
                return characteristic;
              },
            };
          },
        };
      },
      disconnect: () => {
        calls.push('disconnect');
        connected = false;
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const bluetooth: BluetoothLike = {
    requestDevice: async (options) => {
      calls.push(`request:${JSON.stringify(options)}`);
      if (opts.requestError) throw opts.requestError;
      return device;
    },
  };
  const emit = (hex: string) => {
    characteristic.value = new DataView(fromHex(hex).buffer);
    for (const l of valueListeners) l(new Event('characteristicvaluechanged'));
  };
  return { bluetooth, calls, emit, valueListeners };
}

function recorder() {
  const statuses: ScaleStatus[] = [];
  const readings: ScaleReading[] = [];
  const errors: MessageKey[] = [];
  const onCancel = vi.fn();
  return {
    statuses,
    readings,
    errors,
    onCancel,
    events: {
      onStatus: (s: ScaleStatus) => statuses.push(s),
      onReading: (r: ScaleReading) => readings.push(r),
      onError: (k: MessageKey) => errors.push(k),
      onCancel,
    },
  };
}

describe('isWebBluetoothAvailable', () => {
  it('needs navigator.bluetooth and a secure context', () => {
    expect(isWebBluetoothAvailable({ navigator: { bluetooth: {} }, isSecureContext: true })).toBe(true);
    expect(isWebBluetoothAvailable({ navigator: { bluetooth: {} }, isSecureContext: false })).toBe(false);
    expect(isWebBluetoothAvailable({ navigator: {}, isSecureContext: true })).toBe(false);
    expect(isWebBluetoothAvailable({ navigator: undefined, isSecureContext: true })).toBe(false);
  });
});

describe('WebBluetoothScaleReader', () => {
  it('connects through 0x181D / 0x2A9D, parses notifications and cleans up', async () => {
    const fake = fakeBluetooth();
    const rec = recorder();
    const reader = new WebBluetoothScaleReader({
      bluetooth: fake.bluetooth,
      isAvailable: () => true,
      now: () => AT,
    });
    await reader.start(rec.events);

    expect(fake.calls).toEqual([
      'request:{"filters":[{"services":[6173]}]}',
      'connect',
      'service:181d',
      'characteristic:2a9d',
      'startNotifications',
    ]);
    expect(rec.statuses).toEqual(['connecting', 'waiting']);

    fake.emit('00 ff ff');
    fake.emit('06 38 2c e9 07 01 0f 0a 1e 00 01');
    expect(rec.readings.map((r) => r.weightKg)).toEqual([null, 56.6]);
    expect(rec.readings[1].source).toBe('ble');
    expect(latestSuccessful(rec.readings)?.rawHex).toBe('06382ce907010f0a1e0001');

    await reader.stop();
    expect(fake.calls.slice(-2)).toEqual(['stopNotifications', 'disconnect']);
    expect(fake.valueListeners.size).toBe(0);
    expect(rec.statuses.at(-1)).toBe('stopped');
  });

  it('reports unsupported without touching the API', async () => {
    const fake = fakeBluetooth();
    const rec = recorder();
    await new WebBluetoothScaleReader({ bluetooth: fake.bluetooth, isAvailable: () => false }).start(
      rec.events,
    );
    expect(rec.errors).toEqual(['field.ble.unsupported']);
    expect(fake.calls).toEqual([]);
  });

  it('a cancelled chooser returns silently', async () => {
    const fake = fakeBluetooth({ requestError: namedError('NotFoundError') });
    const rec = recorder();
    await new WebBluetoothScaleReader({ bluetooth: fake.bluetooth, isAvailable: () => true }).start(
      rec.events,
    );
    expect(rec.errors).toEqual([]);
    expect(rec.onCancel).toHaveBeenCalledTimes(1);
  });

  it('maps connect and service failures and disconnects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const a = fakeBluetooth({ connectError: namedError('NetworkError') });
      const ra = recorder();
      await new WebBluetoothScaleReader({ bluetooth: a.bluetooth, isAvailable: () => true }).start(
        ra.events,
      );
      expect(ra.errors).toEqual(['field.ble.connectFailed']);

      const b = fakeBluetooth({ serviceError: namedError('NotFoundError') });
      const rb = recorder();
      await new WebBluetoothScaleReader({ bluetooth: b.bluetooth, isAvailable: () => true }).start(
        rb.events,
      );
      expect(rb.errors).toEqual(['field.ble.notStandard']);
      expect(b.calls.at(-1)).toBe('disconnect');
      expect(rb.onCancel).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('hints "no reading" after the timeout, but not once a reading arrived', async () => {
    const timer: { fire: (() => void) | null } = { fire: null };
    const fake = fakeBluetooth();
    const rec = recorder();
    const reader = new WebBluetoothScaleReader({
      bluetooth: fake.bluetooth,
      isAvailable: () => true,
      setTimer: (fn, ms) => {
        expect(ms).toBe(60_000);
        timer.fire = fn;
        return 1;
      },
      clearTimer: () => {
        timer.fire = null;
      },
    });
    await reader.start(rec.events);
    expect(timer.fire).not.toBeNull();
    timer.fire?.();
    expect(rec.errors).toEqual(['field.ble.noReading']);

    await reader.start(rec.events);
    fake.emit('00 38 2c');
    expect(timer.fire).toBeNull();
    await reader.stop();
  });
});
