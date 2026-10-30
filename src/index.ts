/**
 * ds2api
 *
 * Universal OpenAI-compatible SDK for DeepSeek Web API (`chat.deepseek.com`).
 * Works natively across Node.js, Bun, and Cloudflare Workers with pure JS/TS
 * Keccak-f[1600] DeepSeekHashV1 Proof-of-Work (zero WASM / zero Node-only deps).
 *
 * Strictly typed (zero `any`, zero `unknown`) with `ts-pattern` and GoF Design Patterns.
 */

export {
  Deepseek,
  DeepSeek,
  OpenAI,
  DS2OpenAI,
  EdgeHttpRouter,
  toFile,
  default,
} from './openai/client.js';
export * from './@types/index.js';
export * from './types/json.js';
export * from './openai/core.js';
export * from './openai/chat-stream-helper.js';
export * from './openai/engine.js';
export * from './openai/resources.js';
export * from './openai/types.js';
export * from './deepseek/client.js';
export * from './auth/account-pool.js';
export * from './pow/keccak.js';
export * from './protocol/constants.js';
export * from './sse/parser.js';
export * from './toolcall/sieve.js';
export * from './prompt/builder.js';
