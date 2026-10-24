/**
 * Simulated weight scale (Req 34.6, 34.7).
 *
 * "Step on scale" reports `stabilizing` for `stabilizeMs` (1 s), then encodes
 * the weight as a real 0x2A9D payload with user ID 1 and the current local
 * time (flags 0x06), parses it through `parseWeightMeasurement`, and reports
 * the stable reading. Jitter (±0.2 kg) is off by default so the demo preset
 * emits exactly 56.60 kg (`06 38 2c …`).
 *
 * `rng`, `now` and `sleep` are injectable so tests are deterministic.
 */
import { round2 } from './round';
import { readingFromPayload } from './scale';
import type { ScaleReader, ScaleReaderEvents, ScaleReading } from './scale';
import { encodeWeightMeasurement } from './weightScaleEncode';

export const DEFAULT_TARGET_KG = 55.0;
export const DEMO_PRESET_KG = 56.6;
export const JITTER_KG = 0.2;
export const STABILIZE_MS = 1000;
export const SIMULATED_USER_ID = 1;

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export interface SimulatedScaleOptions {
  /** Uniform [0, 1) source for jitter; defaults to `Math.random`. */
  rng?: () => number;
  /** Clock for the payload timestamp; defaults to `new Date()`. */
  now?: () => Date;
  stabilizeMs?: number;
  sleep?: Sleep;
}

/** Target weight for the simulator: the mother's last weight, or 55.0 kg. */
export function defaultTargetKg(lastWeightKg?: number | null): number {
  return typeof lastWeightKg === 'number' && Number.isFinite(lastWeightKg)
    ? lastWeightKg
    : DEFAULT_TARGET_KG;
}

/** Target plus optional uniform jitter in [-0.2, +0.2] kg, on the 0.01 kg grid. */
export function simulatedWeightKg(targetKg: number, jitter: boolean, rng: () => number): number {
  if (!jitter) return targetKg;
  return round2(targetKg + (rng() * 2 - 1) * JITTER_KG);
}

/** 0x2A9D payload as emitted by the simulator: weight, timestamp, user ID 1. */
export function simulatedPayload(weightKg: number, at: Date): Uint8Array {
  return encodeWeightMeasurement({ weightKg, userId: SIMULATED_USER_ID, timestamp: at });
}

const defaultSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

export interface StepOptions {
  jitter?: boolean;
}

export class SimulatedScaleReader implements ScaleReader {
  readonly source = 'simulated' as const;
  private events: ScaleReaderEvents = {};
  private controller: AbortController | null = null;
  private readonly rng: () => number;
  private readonly now: () => Date;
  private readonly stabilizeMs: number;
  private readonly sleep: Sleep;

  constructor(opts: SimulatedScaleOptions = {}) {
    this.rng = opts.rng ?? Math.random;
    this.now = opts.now ?? (() => new Date());
    this.stabilizeMs = opts.stabilizeMs ?? STABILIZE_MS;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async start(events: ScaleReaderEvents): Promise<void> {
    this.events = events;
    this.events.onStatus?.('waiting');
  }

  /**
   * Simulate one weighing. Resolves with the stable reading, or null when
   * `stop()` (or another `step`) interrupted the stabilizing delay.
   */
  async step(targetKg: number, opts: StepOptions = {}): Promise<ScaleReading | null> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.events.onStatus?.('stabilizing');
    try {
      await this.sleep(this.stabilizeMs, controller.signal);
    } catch {
      return null;
    }
    if (controller.signal.aborted) return null;
    this.controller = null;

    const weightKg = simulatedWeightKg(targetKg, opts.jitter ?? false, this.rng);
    const at = this.now();
    const reading = readingFromPayload(simulatedPayload(weightKg, at), 'simulated', at);
    this.events.onReading?.(reading);
    this.events.onStatus?.('waiting');
    return reading;
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    this.controller = null;
    this.events.onStatus?.('stopped');
    this.events = {};
  }
}
