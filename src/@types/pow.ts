/**
 * Proof-of-Work (DeepSeekHashV1) Type Definitions.
 */

import type { JsonObject } from './json.js';

export interface PowChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  expire_at: number;
  difficulty: number;
  signature: string;
  target_path: string;
}

export type PowChallengeInput = PowChallenge | JsonObject;

/**
 * Strategy interface for Proof-of-Work algorithms.
 */
export interface PowSolverStrategy {
  readonly algorithm: string;
  hash(data: Uint8Array | string): Uint8Array;
  solve(
    challengeHex: string,
    salt: string,
    expireAt: number,
    difficulty?: number,
    signal?: AbortSignal | null,
  ): number;
}
