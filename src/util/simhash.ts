// 64-bit SimHash (Charikar) over word shingles, for near-duplicate detection (dedupe L2).
// Similar texts produce hashes with a small Hamming distance.
import { createHash } from 'node:crypto';
import { tokens } from './text.js';

const BITS = 64;
const MASK = (1n << 64n) - 1n;

function hash64(feature: string): bigint {
  return createHash('sha256').update(feature).digest().readBigUInt64BE(0);
}

/** Features: single tokens plus word 2-shingles, so word order carries some weight. */
function features(text: string): string[] {
  const t = tokens(text);
  const out = [...t];
  for (let i = 0; i < t.length - 1; i++) out.push(`${t[i] ?? ''} ${t[i + 1] ?? ''}`);
  return out;
}

/** Returns the SimHash as a 16-character hex string (stored in raw_items.simhash). */
export function simhash(text: string): string {
  const v = new Array<number>(BITS).fill(0);
  for (const f of features(text)) {
    const h = hash64(f);
    for (let i = 0; i < BITS; i++) {
      v[i] = (v[i] ?? 0) + ((h >> BigInt(i)) & 1n ? 1 : -1);
    }
  }
  let out = 0n;
  for (let i = 0; i < BITS; i++) if ((v[i] ?? 0) > 0) out |= 1n << BigInt(i);
  return (out & MASK).toString(16).padStart(16, '0');
}

export function hammingDistance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x > 0n) {
    x &= x - 1n;
    n++;
  }
  return n;
}
