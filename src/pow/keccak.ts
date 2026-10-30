/**
 * Pure TypeScript/JavaScript implementation of DeepSeekHashV1 and Proof-of-Work solver.
 * Compatible with Node.js, Bun, Cloudflare Workers, Deno, and Browsers (zero Node dependencies).
 *
 * Design Patterns applied:
 * - Strategy Pattern (`PowSolverStrategy`, `DeepSeekHashV1Strategy`, `PowSolverRegistry`)
 * - Exhaustive Pattern Matching via `ts-pattern`
 */

import { match, P } from 'ts-pattern';
import { PowAlgorithm } from '../protocol/constants.js';
import { asNumberOr } from '../types/json.js';
import type { PowChallenge, PowChallengeInput, PowSolverStrategy } from '../@types/pow.js';

export type { PowChallenge, PowChallengeInput, PowSolverStrategy };

// Round constants for Keccak-f[1600] rounds 0..23 split into [lo32, hi32]
const RC_LO = new Uint32Array([
  0x00000001, 0x00008082, 0x0000808a, 0x80008000, 0x0000808b, 0x80000001, 0x80008081, 0x00008009,
  0x0000008a, 0x00000088, 0x80008009, 0x8000000a, 0x8000808b, 0x0000008b, 0x00008089, 0x00008003,
  0x00008002, 0x00000080, 0x0000800a, 0x8000000a, 0x80008081, 0x00008080, 0x80000001, 0x80008008,
]);

const RC_HI = new Uint32Array([
  0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000, 0x80000000, 0x80000000,
  0x00000000, 0x00000000, 0x00000000, 0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x80000000,
  0x80000000, 0x80000000, 0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x00000000, 0x80000000,
]);

const RATE = 136; // 1088 bits = 17 * 64-bit lanes
const DEFAULT_POW_DIFFICULTY = 144_000;
const MAX_POW_DIFFICULTY = 10_000_000;

function clampPowDifficulty(difficulty: number): number {
  if (!Number.isFinite(difficulty) || difficulty <= 0) {
    return DEFAULT_POW_DIFFICULTY;
  }
  const truncated = Math.trunc(difficulty);
  return truncated > MAX_POW_DIFFICULTY ? MAX_POW_DIFFICULTY : truncated;
}

const RHO_OFFSETS = new Int32Array([
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
]);

const PI_INDEX = new Int32Array([
  0, 10, 20, 5, 15, 16, 1, 11, 21, 6, 7, 17, 2, 12, 22, 23, 8, 18, 3, 13, 14, 24, 9, 19, 4,
]);

const SCRATCH_C_LO = new Uint32Array(5);
const SCRATCH_C_HI = new Uint32Array(5);
const SCRATCH_B_LO = new Uint32Array(25);
const SCRATCH_B_HI = new Uint32Array(25);
const HEX_LUT: readonly string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0'),
);

/**
 * Executes Keccak-f[1600] rounds 1..23 (skipping round 0) on a 50-element Uint32Array
 * representing 25 x 64-bit lanes as [lo0, hi0, lo1, hi1, ..., lo24, hi24].
 */
export function keccakF23(s: Uint32Array): void {
  const cLo = SCRATCH_C_LO;
  const cHi = SCRATCH_C_HI;
  const bLo = SCRATCH_B_LO;
  const bHi = SCRATCH_B_HI;

  for (let r = 1; r < 24; r++) {
    for (let x = 0; x < 5; x++) {
      const i0 = x * 2;
      const i1 = (x + 5) * 2;
      const i2 = (x + 10) * 2;
      const i3 = (x + 15) * 2;
      const i4 = (x + 20) * 2;
      cLo[x] = s[i0] ^ s[i1] ^ s[i2] ^ s[i3] ^ s[i4];
      cHi[x] = s[i0 + 1] ^ s[i1 + 1] ^ s[i2 + 1] ^ s[i3 + 1] ^ s[i4 + 1];
    }

    for (let x = 0; x < 5; x++) {
      const xm1 = (x + 4) % 5;
      const xp1 = (x + 1) % 5;
      const l = cLo[xp1];
      const h = cHi[xp1];
      const rotLo = (l << 1) | (h >>> 31);
      const rotHi = (h << 1) | (l >>> 31);
      const dLo = cLo[xm1] ^ rotLo;
      const dHi = cHi[xm1] ^ rotHi;

      for (let y = 0; y < 25; y += 5) {
        const idx = (y + x) * 2;
        s[idx] ^= dLo;
        s[idx + 1] ^= dHi;
      }
    }

    for (let i = 0; i < 25; i++) {
      const idx = i * 2;
      const l = s[idx];
      const h = s[idx + 1];
      const offset = RHO_OFFSETS[i];
      const dst = PI_INDEX[i];

      if (offset === 0) {
        bLo[dst] = l;
        bHi[dst] = h;
      } else if (offset < 32) {
        bLo[dst] = (l << offset) | (h >>> (32 - offset));
        bHi[dst] = (h << offset) | (l >>> (32 - offset));
      } else if (offset === 32) {
        bLo[dst] = h;
        bHi[dst] = l;
      } else {
        const k = offset - 32;
        bLo[dst] = (h << k) | (l >>> (32 - k));
        bHi[dst] = (l << k) | (h >>> (32 - k));
      }
    }

    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        const i = y + x;
        const i1 = y + ((x + 1) % 5);
        const i2 = y + ((x + 2) % 5);
        const idx = i * 2;
        s[idx] = bLo[i] ^ (~bLo[i1] & bLo[i2]);
        s[idx + 1] = bHi[i] ^ (~bHi[i1] & bHi[i2]);
      }
    }

    s[0] ^= RC_LO[r];
    s[1] ^= RC_HI[r];
  }
}

function xorBlockIntoState(s: Uint32Array, buf: Uint8Array, offset: number): void {
  for (let i = 0; i < 17; i++) {
    const bOff = offset + i * 8;
    const lo = buf[bOff] | (buf[bOff + 1] << 8) | (buf[bOff + 2] << 16) | (buf[bOff + 3] << 24);
    const hi = buf[bOff + 4] | (buf[bOff + 5] << 8) | (buf[bOff + 6] << 16) | (buf[bOff + 7] << 24);
    s[i * 2] ^= lo >>> 0;
    s[i * 2 + 1] ^= hi >>> 0;
  }
}

function readU32LE(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0
  );
}

function writeU32LE(out: Uint8Array, offset: number, val: number): void {
  out[offset] = val & 0xff;
  out[offset + 1] = (val >>> 8) & 0xff;
  out[offset + 2] = (val >>> 16) & 0xff;
  out[offset + 3] = (val >>> 24) & 0xff;
}

const textEncoder = new TextEncoder();

export function buildPrefix(salt: string, expireAt: number): string {
  return `${salt}_${Math.trunc(expireAt)}_`;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('pow: challenge must be 64 hex chars');
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Concrete Strategy for `DeepSeekHashV1`.
 */
export class DeepSeekHashV1Strategy implements PowSolverStrategy {
  public readonly algorithm = PowAlgorithm.DEEPSEEK_HASH_V1;

  public hash(data: Uint8Array | string): Uint8Array {
    const bytes = typeof data === 'string' ? textEncoder.encode(data) : data;
    const s = new Uint32Array(50);

    let off = 0;
    while (off + RATE <= bytes.length) {
      xorBlockIntoState(s, bytes, off);
      keccakF23(s);
      off += RATE;
    }

    const finalBlock = new Uint8Array(RATE);
    finalBlock.set(bytes.subarray(off));
    finalBlock[bytes.length - off] = 0x06;
    finalBlock[RATE - 1] |= 0x80;
    xorBlockIntoState(s, finalBlock, 0);
    keccakF23(s);

    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      writeU32LE(out, i * 4, s[i]);
    }
    return out;
  }

  public solve(
    challengeHex: string,
    salt: string,
    expireAt: number,
    difficulty: number = 144000,
    signal?: AbortSignal | null,
  ): number {
    const target = hexToBytes(challengeHex);
    const t0 = readU32LE(target, 0);
    const t1 = readU32LE(target, 4);
    const t2 = readU32LE(target, 8);
    const t3 = readU32LE(target, 12);
    const t4 = readU32LE(target, 16);
    const t5 = readU32LE(target, 20);
    const t6 = readU32LE(target, 24);
    const t7 = readU32LE(target, 28);

    const prefix = textEncoder.encode(buildPrefix(salt, expireAt));
    const baseState = new Uint32Array(50);
    let off = 0;
    while (off + RATE <= prefix.length) {
      xorBlockIntoState(baseState, prefix, off);
      keccakF23(baseState);
      off += RATE;
    }
    const tailLen = prefix.length - off;
    const tail = new Uint8Array(RATE);
    tail.set(prefix.subarray(off));

    const s = new Uint32Array(50);
    const numBuf = new Uint8Array(20);
    const buf = new Uint8Array(RATE);
    const buf2 = new Uint8Array(RATE);

    const maxDifficulty = clampPowDifficulty(difficulty);

    for (let n = 0; n < maxDifficulty; n++) {
      if ((n & 0x3ff) === 0 && signal?.aborted) {
        throw signal.reason ?? new Error('PoW computation aborted');
      }

      let v = n;
      let pos = 20;
      if (v === 0) {
        pos--;
        numBuf[pos] = 48; // '0'
      } else {
        while (v > 0) {
          pos--;
          numBuf[pos] = 48 + (v % 10);
          v = Math.floor(v / 10);
        }
      }
      const numLen = 20 - pos;
      s.set(baseState);
      const totalTail = tailLen + numLen;

      if (totalTail < RATE) {
        buf.fill(0);
        buf.set(tail.subarray(0, tailLen), 0);
        buf.set(numBuf.subarray(pos, 20), tailLen);
        buf[totalTail] = 0x06;
        buf[RATE - 1] |= 0x80;
        xorBlockIntoState(s, buf, 0);
        keccakF23(s);
      } else {
        buf.fill(0);
        buf.set(tail.subarray(0, tailLen), 0);
        const firstChunk = RATE - tailLen;
        buf.set(numBuf.subarray(pos, pos + firstChunk), tailLen);
        xorBlockIntoState(s, buf, 0);
        keccakF23(s);

        buf2.fill(0);
        const rem = totalTail - RATE;
        buf2.set(numBuf.subarray(pos + firstChunk, pos + firstChunk + rem), 0);
        buf2[rem] = 0x06;
        buf2[RATE - 1] |= 0x80;
        xorBlockIntoState(s, buf2, 0);
        keccakF23(s);
      }

      if (
        s[0] === t0 &&
        s[1] === t1 &&
        s[2] === t2 &&
        s[3] === t3 &&
        s[4] === t4 &&
        s[5] === t5 &&
        s[6] === t6 &&
        s[7] === t7
      ) {
        return n;
      }
    }

    throw new Error('pow: no solution within difficulty');
  }
}

/**
 * Registry of PoW Solver Strategies.
 */
export class PowSolverRegistry {
  private static readonly strategies = new Map<string, PowSolverStrategy>([
    [PowAlgorithm.DEEPSEEK_HASH_V1, new DeepSeekHashV1Strategy()],
  ]);

  public static register(strategy: PowSolverStrategy): void {
    this.strategies.set(strategy.algorithm, strategy);
  }

  public static resolve(algorithm: string): PowSolverStrategy {
    const strategy = this.strategies.get(algorithm);
    if (!strategy) {
      throw new Error(`pow: unsupported algorithm: ${algorithm}`);
    }
    return strategy;
  }
}

const defaultStrategy = new DeepSeekHashV1Strategy();

/**
 * Computes the 32-byte DeepSeekHashV1 digest of `data`, identical to DeepSeek's WASM `wasm_deepseek_hash_v1`.
 */
export function deepSeekHashV1(data: Uint8Array | string): Uint8Array {
  return defaultStrategy.hash(data);
}

/**
 * Returns the lowercase hex string of `deepSeekHashV1(data)`.
 */
export function deepSeekHashV1Hex(data: Uint8Array | string): string {
  const digest = deepSeekHashV1(data);
  let hex = '';
  for (let i = 0; i < digest.length; i++) {
    hex += HEX_LUT[digest[i]];
  }
  return hex;
}

/**
 * Searches nonce in [0, difficulty) such that DeepSeekHashV1(prefix + nonce) == challengeHex.
 * Uses `ts-pattern` to accept either a `PowChallengeInput` object or positional parameters.
 */
export function solvePow(
  challengeOrHex: PowChallengeInput | string,
  salt?: string,
  expireAt?: number,
  difficulty: number = 144000,
  signal?: AbortSignal | null,
): number {
  const normalized = match(challengeOrHex)
    .with(P.string, (hex) => ({
      algorithm: PowAlgorithm.DEEPSEEK_HASH_V1,
      challengeHex: hex,
      resolvedSalt: salt ?? '',
      resolvedExpireAt: typeof expireAt === 'number' ? Math.trunc(expireAt) : 1680000000,
      resolvedDifficulty: clampPowDifficulty(difficulty),
    }))
    .otherwise((obj) => {
      const rawDiff = asNumberOr(obj.difficulty, DEFAULT_POW_DIFFICULTY);
      return {
        algorithm:
          typeof obj.algorithm === 'string' && obj.algorithm
            ? obj.algorithm
            : PowAlgorithm.DEEPSEEK_HASH_V1,
        challengeHex: typeof obj.challenge === 'string' ? obj.challenge : '',
        resolvedSalt: typeof obj.salt === 'string' ? obj.salt : '',
        resolvedExpireAt: Math.trunc(asNumberOr(obj.expire_at, 1680000000)),
        resolvedDifficulty: clampPowDifficulty(rawDiff),
      };
    });

  const strategy = PowSolverRegistry.resolve(normalized.algorithm);
  return strategy.solve(
    normalized.challengeHex,
    normalized.resolvedSalt,
    normalized.resolvedExpireAt,
    normalized.resolvedDifficulty,
    signal,
  );
}

function encodeBase64(str: string): string {
  const bytes = textEncoder.encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Serializes {algorithm, challenge, salt, answer, signature, target_path} to base64(JSON).
 */
export function buildPowHeader(challenge: PowChallengeInput, answer: number): string {
  return encodeBase64(
    JSON.stringify({
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
      target_path: challenge.target_path,
    }),
  );
}

/**
 * End-to-end solver: PowChallenge -> x-ds-pow-response header string.
 */
export function solveAndBuildHeader(
  challenge: PowChallengeInput,
  signal?: AbortSignal | null,
): string {
  const algo = typeof challenge.algorithm === 'string' ? challenge.algorithm : '';
  PowSolverRegistry.resolve(algo);
  const answer = solvePow(challenge, undefined, undefined, undefined, signal);
  return buildPowHeader(challenge, answer);
}
