/**
 * Web Bluetooth weight-scale reader (Req 35.1–35.8).
 *
 * Flow: `requestDevice({ filters: [{ services: [0x181D] }] })` → `gatt.connect()`
 * → `getPrimaryService(0x181D)` → `getCharacteristic(0x2A9D)` →
 * `startNotifications()` (Web Bluetooth uses it for indications too) → parse
 * each `characteristicvaluechanged` value through `parseWeightMeasurement`.
 *
 * - Unavailable API or insecure context → `field.ble.unsupported`.
 * - No measurement within 60 s → `field.ble.noReading` (a hint; the reader keeps listening).
 * - `stop()` (finish or unmount) stops notifications and disconnects GATT; any
 *   cleanup error is logged with `console.warn` and never shown.
 * - `mapBleError(err, phase)` is pure: it maps an error to a message key, or to
 *   null for a silent return (chooser cancelled, or our own abort).
 */
import type { MessageKey } from '../../shared/i18n';
import { readingFromPayload } from './scale';
import type { ScaleReader, ScaleReaderEvents } from './scale';

export const WEIGHT_SCALE_SERVICE = 0x181d;
export const WEIGHT_MEASUREMENT_CHARACTERISTIC = 0x2a9d;
export const NO_READING_TIMEOUT_MS = 60_000;

// --------------------------------------------------------------------------- minimal Web Bluetooth shapes

// Structural subsets of the `web-bluetooth` types, so tests can pass fakes.
export interface BleCharacteristicLike {
  readonly value?: DataView | null;
  startNotifications(): Promise<unknown>;
  stopNotifications(): Promise<unknown>;
  addEventListener(type: 'characteristicvaluechanged', listener: (ev: Event) => void): void;
  removeEventListener(type: 'characteristicvaluechanged', listener: (ev: Event) => void): void;
}

export interface BleServiceLike {
  getCharacteristic(characteristic: number): Promise<BleCharacteristicLike>;
}

export interface BleServerLike {
  readonly connected: boolean;
  getPrimaryService(service: number): Promise<BleServiceLike>;
}

export interface BleGattLike {
  readonly connected: boolean;
  connect(): Promise<BleServerLike>;
  disconnect(): void;
}

export interface BleDeviceLike {
  readonly gatt?: BleGattLike;
  addEventListener(type: 'gattserverdisconnected', listener: (ev: Event) => void): void;
  removeEventListener(type: 'gattserverdisconnected', listener: (ev: Event) => void): void;
}

export interface BluetoothLike {
  requestDevice(options: RequestDeviceOptions): Promise<BleDeviceLike>;
}

// --------------------------------------------------------------------------- availability

export interface BleEnvironment {
  navigator?: { bluetooth?: unknown } | undefined;
  isSecureContext?: boolean | undefined;
}

function currentEnvironment(): BleEnvironment {
  return {
    navigator: typeof navigator === 'undefined' ? undefined : navigator,
    isSecureContext: typeof window === 'undefined' ? false : window.isSecureContext,
  };
}

/** `'bluetooth' in navigator && window.isSecureContext` (Req 35.1). */
export function isWebBluetoothAvailable(env: BleEnvironment = currentEnvironment()): boolean {
  const nav = env.navigator;
  return !!nav && 'bluetooth' in nav && !!nav.bluetooth && env.isSecureContext === true;
}

// --------------------------------------------------------------------------- error mapping

/**
 * Where an error happened:
 * - `availability`: API missing or insecure context
 * - `request`: `requestDevice` (device chooser)
 * - `connect`: `gatt.connect()`
 * - `service`: `getPrimaryService` / `getCharacteristic`
 * - `notify`: `startNotifications`
 * - `timeout`: no measurement within 60 s
 */
export type BlePhase = 'availability' | 'request' | 'connect' | 'service' | 'notify' | 'timeout';

function errorName(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err) {
    const name = (err as { name: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return '';
}

/** Map a Web Bluetooth error to a message key; `null` means return silently. */
export function mapBleError(err: unknown, phase: BlePhase): MessageKey | null {
  if (phase === 'availability') return 'field.ble.unsupported';
  if (phase === 'timeout') return 'field.ble.noReading';

  const name = errorName(err);
  // Our own abort (stop() while connecting) is never shown.
  if (name === 'AbortError') return null;

  switch (phase) {
    case 'request':
      if (name === 'NotFoundError') return null; // chooser cancelled (Req 35.5)
      if (name === 'SecurityError' || name === 'NotSupportedError') return 'field.ble.unsupported';
      if (name === 'NetworkError') return 'field.ble.connectFailed';
      return 'field.ble.failed';
    case 'connect':
      if (name === 'SecurityError') return 'field.ble.unsupported';
      return 'field.ble.connectFailed'; // NetworkError and friends (Req 35.6)
    case 'service':
      if (name === 'NetworkError') return 'field.ble.connectFailed';
      return 'field.ble.notStandard'; // NotFoundError / NotSupportedError / SecurityError (Req 35.7)
    case 'notify':
      if (name === 'NetworkError') return 'field.ble.connectFailed';
      if (name === 'NotSupportedError' || name === 'NotFoundError') return 'field.ble.notStandard';
      return 'field.ble.failed';
  }
}

// --------------------------------------------------------------------------- reader

export interface WebBluetoothReaderOptions {
  /** Defaults to `navigator.bluetooth`. */
  bluetooth?: BluetoothLike;
  /** Defaults to the current navigator / secure-context check. */
  isAvailable?: () => boolean;
  timeoutMs?: number;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Connection {
  device: BleDeviceLike | null;
  characteristic: BleCharacteristicLike | null;
  notifying: boolean;
  onValue: ((ev: Event) => void) | null;
  onDisconnect: ((ev: Event) => void) | null;
}

class Cancelled extends Error {}

export class WebBluetoothScaleReader implements ScaleReader {
  readonly source = 'ble' as const;
  private readonly opts: WebBluetoothReaderOptions;
  private session = 0;
  private conn: Connection | null = null;
  private timer: unknown = null;
  private events: ScaleReaderEvents = {};

  constructor(opts: WebBluetoothReaderOptions = {}) {
    this.opts = opts;
  }

  private bluetooth(): BluetoothLike | undefined {
    if (this.opts.bluetooth) return this.opts.bluetooth;
    return typeof navigator === 'undefined'
      ? undefined
      : (navigator.bluetooth as BluetoothLike | undefined);
  }

  private available(): boolean {
    return this.opts.isAvailable ? this.opts.isAvailable() : isWebBluetoothAvailable();
  }

  /** Runs the whole connect flow. Resolves once notifications started or the flow ended. */
  async start(events: ScaleReaderEvents): Promise<void> {
    await this.stop();
    const session = ++this.session;
    this.events = events;
    const bt = this.bluetooth();

    if (!this.available() || !bt) {
      events.onStatus?.('idle');
      events.onError?.(mapBleError(null, 'availability') ?? 'field.ble.unsupported');
      return;
    }

    const conn: Connection = {
      device: null,
      characteristic: null,
      notifying: false,
      onValue: null,
      onDisconnect: null,
    };
    this.conn = conn;
    const live = () => {
      if (session !== this.session) throw new Cancelled();
    };

    events.onStatus?.('connecting');
    let phase: BlePhase = 'request';
    try {
      const device = await bt.requestDevice({ filters: [{ services: [WEIGHT_SCALE_SERVICE] }] });
      conn.device = device;
      live();

      phase = 'connect';
      if (!device.gatt) throw Object.assign(new Error('No GATT server'), { name: 'NetworkError' });
      const server = await device.gatt.connect();
      live();
      conn.onDisconnect = () => {
        if (session !== this.session) return;
        this.clearTimeout();
        this.events.onStatus?.('disconnected');
      };
      device.addEventListener('gattserverdisconnected', conn.onDisconnect);

      phase = 'service';
      const service = await server.getPrimaryService(WEIGHT_SCALE_SERVICE);
      live();
      const characteristic = await service.getCharacteristic(WEIGHT_MEASUREMENT_CHARACTERISTIC);
      live();
      conn.characteristic = characteristic;

      conn.onValue = () => {
        if (session !== this.session) return;
        const value = characteristic.value;
        if (!value) return;
        this.clearTimeout();
        const now = this.opts.now ? this.opts.now() : new Date();
        this.events.onReading?.(readingFromPayload(value, 'ble', now));
      };
      characteristic.addEventListener('characteristicvaluechanged', conn.onValue);

      phase = 'notify';
      await characteristic.startNotifications();
      conn.notifying = true;
      live();

      this.armTimeout(session);
      events.onStatus?.('waiting');
    } catch (err) {
      if (err instanceof Cancelled) {
        await this.release(conn);
        return;
      }
      await this.release(conn);
      if (session !== this.session) return;
      this.conn = null;
      events.onStatus?.('idle');
      const key = mapBleError(err, phase);
      if (key === null) {
        if (phase === 'request') events.onCancel?.();
      } else {
        console.warn('[ble] %s failed: %s', phase, errorName(err) || String(err));
        events.onError?.(key);
      }
    }
  }

  async stop(): Promise<void> {
    this.session++;
    this.clearTimeout();
    const conn = this.conn;
    this.conn = null;
    const events = this.events;
    this.events = {};
    if (conn) {
      await this.release(conn);
      events.onStatus?.('stopped');
    }
  }

  private armTimeout(session: number): void {
    this.clearTimeout();
    const set = this.opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.timer = set(() => {
      this.timer = null;
      if (session !== this.session) return;
      this.events.onError?.(mapBleError(null, 'timeout') ?? 'field.ble.noReading');
    }, this.opts.timeoutMs ?? NO_READING_TIMEOUT_MS);
  }

  private clearTimeout(): void {
    if (this.timer === null) return;
    const clear =
      this.opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
    clear(this.timer);
    this.timer = null;
  }

  /** Stop notifications and disconnect; errors are only logged (Req 35.8). */
  private async release(conn: Connection): Promise<void> {
    const { characteristic, device } = conn;
    if (characteristic && conn.onValue) {
      characteristic.removeEventListener('characteristicvaluechanged', conn.onValue);
      conn.onValue = null;
    }
    if (characteristic && conn.notifying) {
      conn.notifying = false;
      try {
        await characteristic.stopNotifications();
      } catch (err) {
        console.warn('[ble] stopNotifications failed', err);
      }
    }
    if (device) {
      if (conn.onDisconnect) {
        device.removeEventListener('gattserverdisconnected', conn.onDisconnect);
        conn.onDisconnect = null;
      }
      try {
        if (device.gatt?.connected) device.gatt.disconnect();
      } catch (err) {
        console.warn('[ble] disconnect failed', err);
      }
    }
    conn.device = null;
    conn.characteristic = null;
  }
}
