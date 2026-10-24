/** Lowercase hex helpers for BLE payloads. */

type ByteSource = Uint8Array | ArrayBuffer | DataView;

function asBytes(src: ByteSource): Uint8Array {
  if (src instanceof Uint8Array) return src;
  if (src instanceof DataView) return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
  return new Uint8Array(src);
}

/** Lowercase hex of every byte, joined by `sep` (default: no separator). */
export function toHex(bytes: ByteSource, sep = ''): string {
  return Array.from(asBytes(bytes), (b) => b.toString(16).padStart(2, '0')).join(sep);
}

/** Parse hex (spaces ignored). Throws on odd length or non-hex characters. */
export function fromHex(str: string): Uint8Array {
  const clean = str.replace(/\s+/g, '');
  if (clean.length % 2 !== 0) throw new Error('HEX_ODD_LENGTH');
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new Error('HEX_INVALID');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
