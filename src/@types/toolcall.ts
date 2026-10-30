/**
 * DSML / XML Tool-Call Parser & Streaming Sieve Type Definitions.
 */

import type { JsonObject } from './json.js';

export interface ParsedToolCall {
  name: string;
  input: JsonObject;
}

export interface ToolCallParseResult {
  calls: ParsedToolCall[];
  sawToolCallSyntax: boolean;
  rejectedByPolicy: boolean;
  rejectedToolNames: string[];
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIStreamToolCall {
  index: number;
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolFunctionSpec {
  name?: string;
  description?: string;
  parameters?: JsonObject;
  input_schema?: JsonObject;
  schema?: JsonObject;
  arguments?: string | JsonObject;
  input?: JsonObject;
}

export interface ToolSchemaInput {
  type?: string;
  name?: string;
  description?: string;
  parameters?: JsonObject;
  input_schema?: JsonObject;
  schema?: JsonObject;
  function?: ToolFunctionSpec;
}

export type ToolsCollectionInput = ReadonlyArray<ToolSchemaInput | JsonObject> | undefined | null;

export interface ToolSieveState {
  pending: string;
  capture: string;
  capturing: boolean;
  codeFenceStack: number[];
  codeFencePendingTicks: number;
  codeFencePendingTildes: number;
  codeFenceLineStart: boolean;
  markdownCodeSpanTicks: number;
  pendingToolRaw: string;
  pendingToolCalls: ParsedToolCall[];
}

export type ToolSieveEvent =
  { type: 'text'; text: string } | { type: 'tool_calls'; calls: ParsedToolCall[] };
