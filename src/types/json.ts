/**
 * Strict, foundational JSON Guard, Codec, and Identifier Generator utilities.
 * Eliminates the need for `any` or `unknown` across the entire SDK.
 *
 * Design Patterns Applied:
 * - Static Guard / Specification Pattern (`JsonGuard`)
 * - Codec / Data Mapper Pattern (`JsonCodec`)
 * - Factory / Generator Pattern (`IdentifierGenerator`)
 */

import type {
  JsonArray,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  OptionalStringRecord,
  QueryRecord,
  QueryValue,
  StringRecord,
} from '../@types/json.js';

export type {
  JsonArray,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  OptionalStringRecord,
  QueryRecord,
  QueryValue,
  StringRecord,
};

const FORBIDDEN_OBJECT_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Specification / Guard Pattern: Type-safe runtime predicates for `JsonValue` nodes.
 */
export class JsonGuard {
  public static isObject(value: JsonValue | undefined): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  public static isArray(value: JsonValue | undefined): value is JsonArray {
    return Array.isArray(value);
  }

  public static isSafeKey(key: string): boolean {
    return Boolean(key) && !FORBIDDEN_OBJECT_KEYS.has(key);
  }

  public static hasOwn(obj: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }
}

/**
 * Codec / Data Mapper Pattern: Fault-tolerant JSON parsing and primitive value coercion.
 */
export class JsonCodec {
  public static parse(raw: string): JsonValue | null {
    try {
      return JSON.parse(raw) as JsonValue;
    } catch {
      return null;
    }
  }

  public static parseObject(raw: string): JsonObject | null {
    const parsed = JsonCodec.parse(raw);
    return JsonGuard.isObject(parsed) ? parsed : null;
  }

  public static asCleanString(value: JsonValue | undefined): string {
    if (typeof value === 'string') {
      return value.trim();
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (Array.isArray(value) && value.length > 0) {
      return JsonCodec.asCleanString(value[0]);
    }
    return '';
  }

  public static asNumberOr(value: JsonValue | undefined, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return fallback;
  }
}

/**
 * Factory / Generator Pattern: Generates timestamps and collision-resistant identifiers.
 */
export class IdentifierGenerator {
  public static nowUnixSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  public static randomId(prefix: string): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
    }
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      let hex = '';
      for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
      }
      return `${prefix}_${hex}`;
    }
    return `${prefix}_${Date.now().toString(36)}`;
  }
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return JsonGuard.isObject(value);
}

export function isJsonArray(value: JsonValue | undefined): value is JsonArray {
  return JsonGuard.isArray(value);
}

export function safeJsonParse(raw: string): JsonValue | null {
  return JsonCodec.parse(raw);
}

export function safeJsonParseObject(raw: string): JsonObject | null {
  return JsonCodec.parseObject(raw);
}

export function asCleanString(value: JsonValue | undefined): string {
  return JsonCodec.asCleanString(value);
}

export function asNumberOr(value: JsonValue | undefined, fallback: number): number {
  return JsonCodec.asNumberOr(value, fallback);
}

export function nowUnixSeconds(): number {
  return IdentifierGenerator.nowUnixSeconds();
}

export function randomId(prefix: string): string {
  return IdentifierGenerator.randomId(prefix);
}
