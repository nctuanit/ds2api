/**
 * Foundational JSON & Primitive Type Definitions.
 * Strictly typed with zero `any` and zero `unknown`.
 */

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export type JsonArray = JsonValue[];

export type StringRecord = Record<string, string>;

export type OptionalStringRecord = Record<string, string | undefined>;

export type QueryValue = string | number | boolean | null | undefined;

export type QueryRecord = Record<string, QueryValue>;
