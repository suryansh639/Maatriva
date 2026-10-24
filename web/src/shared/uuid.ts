/**
 * Record id generation (Req 26.3).
 *
 * `crypto.randomUUID` is only available in secure contexts (HTTPS or localhost);
 * on a plain-HTTP LAN origin it is missing, so a version-4 generator built on
 * `crypto.getRandomValues` (available in every context) is used instead.
 */

export type FillRandom = (bytes: Uint8Array) => Uint8Array;

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** Format 16 random bytes as a lowercase RFC 4122 version-4 UUID. Does not mutate input. */
export function uuidV4FromBytes(random: Uint8Array): string {
  if (random.length < 16) throw new RangeError('uuidV4FromBytes needs 16 bytes');
  const b = Uint8Array.from(random.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = Array.from(b, (x) => HEX[x]);
  return (
    h.slice(0, 4).join('') +
    '-' +
    h.slice(4, 6).join('') +
    '-' +
    h.slice(6, 8).join('') +
    '-' +
    h.slice(8, 10).join('') +
    '-' +
    h.slice(10, 16).join('')
  );
}

function defaultFill(bytes: Uint8Array): Uint8Array {
  return globalThis.crypto.getRandomValues(bytes);
}

/** The fallback generator: v4 UUID from `fill` (defaults to `crypto.getRandomValues`). */
export function newIdFallback(fill: FillRandom = defaultFill): string {
  return uuidV4FromBytes(fill(new Uint8Array(16)));
}

/** A new lowercase v4 UUID for a client-created record. */
export function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID().toLowerCase();
  }
  return newIdFallback();
}
