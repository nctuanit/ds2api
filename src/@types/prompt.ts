/**
 * Prompt Builder & Standard Request Normalization Type Definitions.
 */

import type { JsonObject, JsonValue } from './json.js';
import type { OpenAIToolCall, ToolsCollectionInput } from './toolcall.js';

export type ToolChoiceMode = 'auto' | 'none' | 'required' | 'forced';

export interface ToolChoicePolicy {
  mode: ToolChoiceMode;
  forcedName?: string;
  allowed?: Set<string>;
}

export interface NormalizedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export type RequestSurface = 'openai_chat' | 'openai_responses' | 'openai_completions';

export interface PromptMessageLike {
  role?: string;
  content?: JsonValue | ReadonlyArray<JsonObject | string>;
  reasoning_content?: string | null;
  tool_calls?: ReadonlyArray<OpenAIToolCall | JsonObject>;
  tool_call_id?: string;
  name?: string;
}

export interface StandardRequestInput {
  model?: string;
  messages?: ReadonlyArray<PromptMessageLike | JsonObject>;
  input?: string | ReadonlyArray<PromptMessageLike | JsonObject | string>;
  instructions?: string | null;
  prompt?: string | string[];
  tools?: ToolsCollectionInput;
  tool_choice?: string | JsonObject | null;
  response_format?: JsonObject | null;
  text?: JsonObject | null;
  stream?: boolean | null;
  thinking_enabled?: boolean;
  thinking?: JsonObject | null;
  reasoning_effort?: string | null;
  reasoning?: JsonObject | null;
  search_enabled?: boolean;
  ref_file_ids?: string[];
  file_ids?: string[];
  temperature?: number | null;
  top_p?: number | null;
  max_tokens?: number | null;
  max_completion_tokens?: number | null;
  presence_penalty?: number | null;
  frequency_penalty?: number | null;
  stop?: string | string[] | null;
}

export interface NormalizedStandardRequest {
  surface: RequestSurface;
  requestedModel: string;
  resolvedModel: string;
  responseModel: string;
  messages: Array<PromptMessageLike | JsonObject>;
  toolsRaw: ToolsCollectionInput;
  finalPrompt: string;
  toolNames: string[];
  toolChoice: ToolChoicePolicy;
  stream: boolean;
  thinking: boolean;
  search: boolean;
  refFileIds: string[];
  passThrough: JsonObject;
}
