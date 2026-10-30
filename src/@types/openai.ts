/**
 * Comprehensive OpenAI SDK & Execution Engine Type Definitions.
 * Strictly typed without `any` or `unknown`.
 */

import type { JsonObject, JsonValue, QueryRecord, StringRecord } from './json.js';
import type { ChatUsage } from './sse.js';
import type { OpenAIStreamToolCall, OpenAIToolCall, ParsedToolCall } from './toolcall.js';
import type { DeepSeekClient } from '../deepseek/client.js';

// ─── Core HTTP & Request Option Types ────────────────────────────────────────

export type RequestBodyPayload =
  string | Uint8Array | ArrayBuffer | FormData | Blob | JsonObject | null | undefined;

export type ErrorReason = Error | JsonValue | undefined;

export interface RequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal | null;
  timeout?: number;
  maxRetries?: number;
  query?: QueryRecord;
  body?: RequestBodyPayload;
  /** Optional override DeepSeek token for this specific call */
  deepseekToken?: string;
}

export interface GlobalWithProcess {
  process?: {
    env?: Record<string, string | undefined>;
  };
}

// ─── Execution Engine Types ──────────────────────────────────────────────────

export interface EngineOptions {
  ds: DeepSeekClient;
  modelAliases?: StringRecord;
  autoDeleteSessions?: 'none' | 'single' | 'all';
  stripReferenceMarkers?: boolean;
}

export interface CollectedTurn {
  sessionId: string;
  thinking: string;
  text: string;
  toolCalls: ParsedToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'content_filter' | 'length';
  responseMessageId?: string;
}

// ─── Chat Completions Types ──────────────────────────────────────────────────

export type ChatCompletionRole =
  'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'function';

export interface ChatCompletionContentPartText {
  type: 'text' | 'input_text' | 'output_text';
  text: string;
}

export interface ChatCompletionContentPartImage {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

export interface ChatCompletionContentPartFile {
  type: 'file';
  file: {
    file_id?: string;
    file_data?: string;
    filename?: string;
  };
}

export type ChatCompletionContentPart =
  ChatCompletionContentPartText | ChatCompletionContentPartImage | ChatCompletionContentPartFile;

export interface ChatCompletionMessageParam {
  role: ChatCompletionRole;
  content: string | ChatCompletionContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
  reasoning_content?: string | null;
}

export type ToolRunnableCallback = (args: JsonObject) => JsonValue | Promise<JsonValue>;
export type ToolArgumentParser = (input: string) => JsonObject;

export interface ChatCompletionTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: JsonObject;
    strict?: boolean;
    /** Optional runnable callback for chat.completions.runTools */
    function?: ToolRunnableCallback;
    parse?: ToolArgumentParser;
  };
}

export interface ChatCompletionMessage {
  role: 'assistant';
  content: string | null;
  reasoning_content?: string | null;
  refusal?: string | null;
  tool_calls?: OpenAIToolCall[];
}

export interface ParsedChatCompletionMessage<ParsedT = JsonValue> extends ChatCompletionMessage {
  parsed: ParsedT | null;
}

export type ChatFinishReason =
  'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' | null;

export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionMessage;
  logprobs: null;
  finish_reason: ChatFinishReason;
}

export interface ParsedChoice<ParsedT = JsonValue> {
  index: number;
  message: ParsedChatCompletionMessage<ParsedT>;
  logprobs: null;
  finish_reason: ChatFinishReason;
}

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: ChatUsage;
  system_fingerprint?: string;
}

export interface ParsedChatCompletion<ParsedT = JsonValue> extends Omit<ChatCompletion, 'choices'> {
  choices: ParsedChoice<ParsedT>[];
}

export interface ChatCompletionChunkDelta {
  role?: 'assistant';
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: OpenAIStreamToolCall[];
  refusal?: string | null;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  logprobs?: null;
  finish_reason: ChatFinishReason;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: ChatUsage | null;
}

export type ChatCompletionToolChoiceOption =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } }
  | { type: 'allowed_tools'; allowed_tools?: JsonObject; mode?: string };

export type ChatCompletionResponseFormat =
  | { type: 'text' | 'json_object' }
  | {
      type: 'json_schema';
      json_schema: {
        name: string;
        description?: string;
        schema?: JsonObject;
        strict?: boolean;
      };
    };

export interface ChatCompletionCreateParamsBase {
  model: string;
  messages: ChatCompletionMessageParam[];
  stream?: boolean | null;
  tools?: ChatCompletionTool[];
  tool_choice?: ChatCompletionToolChoiceOption;
  temperature?: number | null;
  top_p?: number | null;
  max_tokens?: number | null;
  max_completion_tokens?: number | null;
  presence_penalty?: number | null;
  frequency_penalty?: number | null;
  stop?: string | string[] | null;
  response_format?: ChatCompletionResponseFormat;
  reasoning_effort?: 'none' | 'low' | 'medium' | 'high' | 'minimal' | 'xhigh' | null;
  thinking?: { type: 'enabled' | 'disabled' };
  thinking_enabled?: boolean;
  search_enabled?: boolean;
  ref_file_ids?: string[];
  stream_options?: { include_usage?: boolean } | null;
  store?: boolean | null;
  metadata?: StringRecord | null;
  user?: string;
}

export interface ChatCompletionCreateParamsNonStreaming extends ChatCompletionCreateParamsBase {
  stream?: false | null;
}

export interface ChatCompletionCreateParamsStreaming extends ChatCompletionCreateParamsBase {
  stream: true;
}

export type ChatCompletionCreateParams =
  ChatCompletionCreateParamsNonStreaming | ChatCompletionCreateParamsStreaming;

export type ChatCompletionStreamEventMap = {
  connect: () => void;
  chunk: (chunk: ChatCompletionChunk, snapshot: ChatCompletion) => void;
  content: (delta: string, snapshot: string) => void;
  reasoning_content: (delta: string, snapshot: string) => void;
  message: (message: ChatCompletionMessage) => void;
  chatCompletion: (completion: ChatCompletion) => void;
  finalChatCompletion: (completion: ChatCompletion) => void;
  finalContent: (contentSnapshot: string) => void;
  finalMessage: (message: ChatCompletionMessage) => void;
  error: (error: Error) => void;
  abort: (error: Error) => void;
  end: () => void;
};

export type StreamListenerBuckets = {
  [K in keyof ChatCompletionStreamEventMap]: Set<ChatCompletionStreamEventMap[K]>;
};

// ─── Legacy Completions (/v1/completions) ────────────────────────────────────

export interface CompletionCreateParamsBase {
  model: string;
  prompt: string | string[];
  stream?: boolean | null;
  max_tokens?: number | null;
  temperature?: number | null;
  top_p?: number | null;
  stop?: string | string[] | null;
  thinking?: { type: 'enabled' | 'disabled' };
  reasoning_effort?: 'none' | 'low' | 'medium' | 'high' | null;
}

export interface CompletionChoice {
  text: string;
  index: number;
  logprobs: null;
  finish_reason: 'stop' | 'length' | 'content_filter' | null;
}

export interface Completion {
  id: string;
  object: 'text_completion';
  created: number;
  model: string;
  choices: CompletionChoice[];
  usage?: ChatUsage;
}

// ─── OpenAI Responses API (/v1/responses) ────────────────────────────────────

export type ResponseOutputItemMessageContent =
  | { type: 'output_text'; text: string; annotations?: JsonObject[] }
  | { type: 'reasoning'; text: string };

export interface ResponseOutputItemMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  status?: 'completed' | 'in_progress';
  content: ResponseOutputItemMessageContent[];
}

export interface ResponseOutputItemFunctionCall {
  id: string;
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
  status: 'completed' | 'in_progress';
}

export type ResponseOutputItem = ResponseOutputItemMessage | ResponseOutputItemFunctionCall;

export interface ResponseUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  output_tokens_details?: {
    reasoning_tokens: number;
  };
}

export interface ResponseObject<ParsedT = JsonValue> {
  id: string;
  type: 'response';
  object: 'response';
  created_at: number;
  status: 'completed' | 'failed' | 'in_progress' | 'cancelled';
  model: string;
  output: ResponseOutputItem[];
  output_text: string;
  output_parsed?: ParsedT | null;
  usage: ResponseUsage;
}

export interface ResponseStreamEvent {
  type: string;
  response?: ResponseObject;
  item_id?: string;
  output_index?: number;
  content_index?: number;
  delta?: string;
  text?: string;
  arguments?: string;
  name?: string;
  call_id?: string;
}

export type ResponseInputItem = string | ChatCompletionMessageParam | JsonObject;

export type ResponseToolDefinition =
  | ChatCompletionTool
  | {
      type: 'function' | string;
      name?: string;
      description?: string;
      parameters?: JsonObject;
      function?: {
        name: string;
        description?: string;
        parameters?: JsonObject;
      };
    };

export interface ResponseCreateParamsBase {
  model: string;
  input?: string | ResponseInputItem[];
  messages?: ChatCompletionMessageParam[];
  instructions?: string | null;
  tools?: ResponseToolDefinition[];
  tool_choice?: ChatCompletionToolChoiceOption | { type: string; name?: string };
  stream?: boolean | null;
  reasoning?: { effort?: 'none' | 'low' | 'medium' | 'high' } | null;
  thinking?: { type: 'enabled' | 'disabled' };
  text?: { format?: JsonObject };
  response_format?: ChatCompletionResponseFormat;
  temperature?: number | null;
  top_p?: number | null;
  max_output_tokens?: number | null;
  ref_file_ids?: string[];
  store?: boolean | null;
  metadata?: StringRecord | null;
}

export interface ResponseCreateParamsNonStreaming extends ResponseCreateParamsBase {
  stream?: false | null;
}

export interface ResponseCreateParamsStreaming extends ResponseCreateParamsBase {
  stream: true;
}

export type ResponseCreateParams = ResponseCreateParamsNonStreaming | ResponseCreateParamsStreaming;

// ─── Files API (/v1/files) ───────────────────────────────────────────────────

export interface FileObject {
  id: string;
  object: 'file';
  bytes: number;
  created_at: number;
  filename: string;
  purpose: string;
  status: 'uploaded' | 'processed' | 'error' | string;
  status_details?: string | null;
  account_id?: string;
}

export interface CustomFilePayload {
  name?: string;
  type?: string;
  data: Uint8Array | ArrayBuffer | string;
}

export type Uploadable = Blob | File | Uint8Array | ArrayBuffer | string | CustomFilePayload;

export interface FileCreateParams {
  file: Uploadable;
  purpose: 'assistants' | 'batch' | 'fine-tune' | 'vision' | 'user_data' | 'evals' | string;
  filename?: string;
  contentType?: string;
  model?: string;
  model_type?: 'default' | 'expert' | 'vision';
}

export interface FileDeleted {
  id: string;
  object: 'file';
  deleted: boolean;
}

// ─── Client Options ──────────────────────────────────────────────────────────

export interface OpenAIClientOptions {
  apiKey?: string;
  organization?: string | null;
  project?: string | null;
  baseURL?: string;
  timeout?: number;
  maxRetries?: number;
  defaultHeaders?: StringRecord;
  defaultQuery?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  accounts?: Array<
    | string
    | {
        id?: string;
        email?: string;
        mobile?: string;
        password?: string;
        token?: string;
      }
  >;
  modelAliases?: StringRecord;
  autoDeleteSession?: boolean | 'none' | 'single' | 'all';
  stripReferenceMarkers?: boolean;
  /**
   * File path to persist and reuse logged-in Bearer tokens across runs (default: `'.deepseek-tokens.json'`).
   * Set to `false` to disable file caching, or pass a custom file path (e.g. `'./token.json'`).
   */
  tokenCacheFile?: string | false;
}

export type DeepseekClientOptions = OpenAIClientOptions;
