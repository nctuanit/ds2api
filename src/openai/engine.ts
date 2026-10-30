/**
 * Core Execution Engine bridging DeepSeek Web API to OpenAI Chat Completions,
 * Text Completions, Responses API, and Files.
 *
 * Design Patterns Applied:
 * - Adapter Pattern (`RequestPayloadAdapter`) to convert typed SDK params into `JsonObject`
 * - Factory Pattern (`OpenAIResponseFactory`) for standardized OpenAI response payloads
 * - Declarative pattern matching with `ts-pattern` (`match`)
 */

import { match } from 'ts-pattern';
import { DeepSeekClient } from '../deepseek/client.js';
import { RequestAuth } from '../auth/account-pool.js';
import {
  DEEPSEEK_COMPLETION_TARGET_PATH,
  FinishReasonConst,
  FragmentTypeConst,
  MessageRole,
  OpenAIObjectType,
  RequestSurfaceConst,
  SessionCleanupMode,
} from '../protocol/constants.js';
import {
  buildCompletionPayload,
  NormalizedStandardRequest,
  normalizeOpenAIRequest,
} from '../prompt/builder.js';
import {
  buildUsage,
  iterateSSEDataPayloads,
  parseChunkForContent,
  trimContinuationOverlap,
} from '../sse/parser.js';
import {
  createToolSieveState,
  flushToolSieve,
  formatOpenAIStreamToolCalls,
  formatOpenAIToolCalls,
  ParsedToolCall,
  parseStandaloneToolCallsDetailed,
  processToolSieveChunk,
  ToolSieveEvent,
} from '../toolcall/sieve.js';
import { APIError, createLinkedAbortController, RequestOptions, Stream } from './core.js';
import {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  Completion,
  CompletionCreateParamsBase,
  FileObject,
  ResponseCreateParams,
  ResponseObject,
  ResponseOutputItem,
  ResponseOutputItemMessageContent,
  ResponseStreamEvent,
} from './types.js';
import {
  JsonArray,
  JsonObject,
  JsonValue,
  nowUnixSeconds,
  randomId,
  safeJsonParseObject,
  StringRecord,
} from '../types/json.js';
import type { CollectedTurn, EngineOptions } from '../@types/openai.js';

export type { CollectedTurn, EngineOptions };

// ─── Adapter Pattern: Request Payload Adapter ────────────────────────────────

/**
 * Adapter Pattern: Converts strongly-typed SDK request parameter interfaces
 * (`ChatCompletionCreateParams`, `CompletionCreateParamsBase`, `ResponseCreateParams`)
 * into a strict `JsonObject` suitable for prompt normalization.
 */
export class RequestPayloadAdapter {
  public static fromChatParams(params: ChatCompletionCreateParams): JsonObject {
    const serialized: JsonObject = safeJsonParseObject(JSON.stringify(params)) ?? {};
    if (params.tools && params.tools.length > 0) {
      const toolsJson: JsonArray = params.tools.map((t) => ({
        type: t.type,
        function: {
          name: t.function.name,
          ...(t.function.description ? { description: t.function.description } : {}),
          ...(t.function.parameters ? { parameters: t.function.parameters } : {}),
          ...(t.function.strict !== undefined ? { strict: t.function.strict } : {}),
        },
      }));
      serialized.tools = toolsJson;
    }
    return serialized;
  }

  public static fromCompletionParams(params: CompletionCreateParamsBase): JsonObject {
    return safeJsonParseObject(JSON.stringify(params)) ?? {};
  }

  public static fromResponsesParams(params: ResponseCreateParams): JsonObject {
    return safeJsonParseObject(JSON.stringify(params)) ?? {};
  }
}

// ─── Factory Pattern: OpenAI Response Factory ────────────────────────────────

function toResponseUsage(chatUsage: ReturnType<typeof buildUsage>): ResponseObject['usage'] {
  return {
    input_tokens: chatUsage.prompt_tokens,
    output_tokens: chatUsage.completion_tokens,
    total_tokens: chatUsage.total_tokens,
    output_tokens_details: {
      reasoning_tokens: chatUsage.completion_tokens_details.reasoning_tokens,
    },
  };
}

export class OpenAIResponseFactory {
  public static createChatCompletion(
    stdReq: NormalizedStandardRequest,
    turn: CollectedTurn,
  ): ChatCompletion {
    const formattedToolCalls =
      turn.toolCalls.length > 0
        ? formatOpenAIToolCalls(turn.toolCalls, stdReq.toolsRaw)
        : undefined;

    const hasToolCalls = Boolean(formattedToolCalls && formattedToolCalls.length > 0);
    const message: ChatCompletion['choices'][0]['message'] = {
      role: MessageRole.ASSISTANT,
      content: hasToolCalls ? null : turn.text,
    };
    if (turn.thinking) {
      message.reasoning_content = turn.thinking;
    }
    if (formattedToolCalls && formattedToolCalls.length > 0) {
      message.tool_calls = formattedToolCalls;
    }

    return {
      id: turn.sessionId || randomId('chatcmpl'),
      object: OpenAIObjectType.CHAT_COMPLETION,
      created: nowUnixSeconds(),
      model: stdReq.responseModel,
      choices: [
        {
          index: 0,
          message,
          logprobs: null,
          finish_reason: hasToolCalls ? FinishReasonConst.TOOL_CALLS : turn.finishReason,
        },
      ],
      usage: buildUsage(stdReq.finalPrompt, turn.thinking, turn.text),
    };
  }

  public static createTextCompletion(
    stdReq: NormalizedStandardRequest,
    turn: CollectedTurn,
  ): Completion {
    return {
      id: turn.sessionId || randomId('cmpl'),
      object: OpenAIObjectType.TEXT_COMPLETION,
      created: nowUnixSeconds(),
      model: stdReq.responseModel,
      choices: [
        {
          text: turn.text,
          index: 0,
          logprobs: null,
          finish_reason:
            turn.finishReason === FinishReasonConst.TOOL_CALLS
              ? FinishReasonConst.STOP
              : turn.finishReason,
        },
      ],
      usage: buildUsage(stdReq.finalPrompt, turn.thinking, turn.text),
    };
  }

  public static createResponseObject(
    stdReq: NormalizedStandardRequest,
    turn: CollectedTurn,
    responseId: string = randomId('resp'),
  ): ResponseObject {
    const output: ResponseOutputItem[] = [];
    let exposedOutputText = turn.text;

    if (turn.toolCalls.length > 0) {
      exposedOutputText = '';
      if (turn.thinking.trim()) {
        output.push({
          id: randomId('msg'),
          type: 'message',
          role: MessageRole.ASSISTANT,
          status: 'completed',
          content: [{ type: 'reasoning', text: turn.thinking }],
        });
      }
      const formattedCalls = formatOpenAIToolCalls(turn.toolCalls, stdReq.toolsRaw);
      for (const tc of formattedCalls) {
        output.push({
          id: randomId('fc'),
          type: 'function_call',
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
          status: 'completed',
        });
      }
    } else {
      const content: ResponseOutputItemMessageContent[] = [];
      if (turn.thinking) {
        content.push({ type: 'reasoning', text: turn.thinking });
      }
      if (turn.text.trim()) {
        content.push({ type: 'output_text', text: turn.text });
      }
      if (!turn.text.trim() && turn.thinking.trim()) {
        exposedOutputText = turn.thinking;
      }
      output.push({
        id: randomId('msg'),
        type: 'message',
        role: MessageRole.ASSISTANT,
        status: 'completed',
        content,
      });
    }

    return {
      id: responseId,
      type: OpenAIObjectType.RESPONSE,
      object: OpenAIObjectType.RESPONSE,
      created_at: nowUnixSeconds(),
      status: 'completed',
      model: stdReq.responseModel,
      output,
      output_text: exposedOutputText,
      usage: toResponseUsage(buildUsage(stdReq.finalPrompt, turn.thinking, turn.text)),
    };
  }
}

const MAX_IN_MEMORY_STORE_ENTRIES = 500;

export function setBoundedStoreEntry<V>(
  store: Map<string, V>,
  key: string,
  value: V,
  maxEntries: number = MAX_IN_MEMORY_STORE_ENTRIES,
): void {
  if (store.has(key)) {
    store.delete(key);
  } else if (store.size >= maxEntries) {
    const oldestKey = store.keys().next().value;
    if (oldestKey !== undefined) {
      store.delete(oldestKey);
    }
  }
  store.set(key, value);
}

export class ExecutionEngine {
  public readonly ds: DeepSeekClient;
  public modelAliases: StringRecord;
  public autoDeleteSessions: 'none' | 'single' | 'all';
  public stripReferenceMarkers: boolean;

  // In-memory stores for stateful OpenAI SDK methods (retrieve/list/update/delete)
  public readonly chatCompletionsStore = new Map<
    string,
    ChatCompletion & { metadata?: StringRecord | null }
  >();
  public readonly responsesStore = new Map<
    string,
    { response: ResponseObject; inputItems: JsonValue[] }
  >();
  public readonly filesStore = new Map<string, { content: Uint8Array; meta: FileObject }>();

  constructor(options: EngineOptions) {
    this.ds = options.ds;
    this.modelAliases = { ...(options.modelAliases ?? {}) };
    this.autoDeleteSessions = options.autoDeleteSessions ?? SessionCleanupMode.NONE;
    this.stripReferenceMarkers = options.stripReferenceMarkers ?? true;
  }

  private async scheduleAutoDelete(auth: RequestAuth, sessionId: string): Promise<void> {
    if (!auth.token) return;
    try {
      await match(this.autoDeleteSessions)
        .with(SessionCleanupMode.NONE, async () => {})
        .with(SessionCleanupMode.SINGLE, async () => {
          if (sessionId) {
            await this.ds.deleteSession(auth, sessionId);
          }
        })
        .with(SessionCleanupMode.ALL, async () => {
          await this.ds.deleteAllSessions(auth);
        })
        .exhaustive();
    } catch {
      // Ignore background session cleanup errors
    }
  }

  public async startUpstreamCompletion(
    stdReq: NormalizedStandardRequest,
    options?: RequestOptions,
  ): Promise<{
    auth: RequestAuth;
    sessionId: string;
    payload: JsonObject;
    powHeader: string;
    response: Response;
  }> {
    const signal = options?.signal;
    const auth = await this.ds.pool.acquire(options?.deepseekToken, signal);
    const sessionId = await this.ds.createSession(auth, signal);
    const powHeader = await this.ds.getPow(auth, DEEPSEEK_COMPLETION_TARGET_PATH, signal);
    const payload = buildCompletionPayload(stdReq, sessionId);
    const response = await this.ds.callCompletion(auth, payload, powHeader, signal);

    if (!response.ok || !response.body) {
      const bodyText = await response.text().catch(() => '');
      throw APIError.generate(
        response.status || 500,
        { message: bodyText || `Upstream DeepSeek HTTP ${response.status}` },
        bodyText || `Upstream DeepSeek HTTP ${response.status}`,
        undefined,
      );
    }

    return { auth, sessionId, payload, powHeader, response };
  }

  public async collectTurn(
    stdReq: NormalizedStandardRequest,
    options?: RequestOptions,
  ): Promise<CollectedTurn> {
    const { auth, sessionId, response } = await this.startUpstreamCompletion(stdReq, options);
    let currentType: 'thinking' | 'text' = stdReq.thinking ? 'thinking' : 'text';
    let thinkingAcc = '';
    let textAcc = '';
    let contentFilter = false;
    let responseMessageId: string | undefined;

    try {
      for await (const chunk of iterateSSEDataPayloads(response.body!, options?.signal)) {
        const parsed = parseChunkForContent(
          chunk,
          stdReq.thinking,
          currentType,
          this.stripReferenceMarkers,
        );
        if (!parsed.parsed) continue;
        if (parsed.responseMessageId) {
          responseMessageId = parsed.responseMessageId;
        }
        if (parsed.errorMessage) {
          throw APIError.generate(
            500,
            { message: parsed.errorMessage },
            parsed.errorMessage,
            undefined,
          );
        }
        if (parsed.contentFilter) {
          contentFilter = true;
          break;
        }
        currentType = parsed.newType;
        for (const p of parsed.parts) {
          match(p.type)
            .with('thinking', () => {
              thinkingAcc += trimContinuationOverlap(thinkingAcc, p.text);
            })
            .with('text', () => {
              textAcc += trimContinuationOverlap(textAcc, p.text);
            })
            .exhaustive();
        }
        if (parsed.finished) {
          break;
        }
      }
    } finally {
      void this.scheduleAutoDelete(auth, sessionId);
    }

    let toolCalls: ParsedToolCall[] = [];
    let finalText = textAcc;

    if (stdReq.toolNames.length > 0 && !stdReq.toolChoice.mode.includes('none')) {
      const sieve = createToolSieveState();
      const events = [
        ...processToolSieveChunk(sieve, textAcc, stdReq.toolNames),
        ...flushToolSieve(sieve, stdReq.toolNames),
      ];
      const textParts: string[] = [];
      for (const ev of events) {
        match(ev)
          .with({ type: 'tool_calls' }, ({ calls }) => {
            toolCalls.push(...calls);
          })
          .with({ type: 'text' }, ({ text }) => {
            textParts.push(text);
          })
          .exhaustive();
      }
      if (toolCalls.length > 0) {
        finalText = textParts.join('').trim();
      } else {
        const standalone = parseStandaloneToolCallsDetailed(textAcc, stdReq.toolNames);
        if (standalone.calls.length > 0) {
          toolCalls = standalone.calls;
          finalText = '';
        }
      }
    }

    const finishReason: CollectedTurn['finishReason'] = match({
      contentFilter,
      hasTools: toolCalls.length > 0,
    })
      .with({ contentFilter: true }, () => FinishReasonConst.CONTENT_FILTER)
      .with({ hasTools: true }, () => FinishReasonConst.TOOL_CALLS)
      .otherwise(() => FinishReasonConst.STOP);

    return {
      sessionId,
      thinking: thinkingAcc,
      text: finalText,
      toolCalls,
      finishReason,
      responseMessageId,
    };
  }

  public async executeChatCompletionNonStream(
    params: ChatCompletionCreateParams,
    options?: RequestOptions,
  ): Promise<ChatCompletion> {
    const stdReq = normalizeOpenAIRequest(
      RequestPayloadAdapter.fromChatParams(params),
      RequestSurfaceConst.OPENAI_CHAT,
      this.modelAliases,
    );
    const turn = await this.collectTurn(stdReq, options);
    const completion = OpenAIResponseFactory.createChatCompletion(stdReq, turn);

    setBoundedStoreEntry(this.chatCompletionsStore, completion.id, {
      ...completion,
      metadata: params.metadata ?? null,
    });
    return completion;
  }

  public async executeChatCompletionStream(
    params: ChatCompletionCreateParams,
    options?: RequestOptions,
  ): Promise<Stream<ChatCompletionChunk>> {
    const stdReq = normalizeOpenAIRequest(
      RequestPayloadAdapter.fromChatParams(params),
      RequestSurfaceConst.OPENAI_CHAT,
      this.modelAliases,
    );
    const controller = createLinkedAbortController(options?.signal);

    const { auth, sessionId, response } = await this.startUpstreamCompletion(stdReq, {
      ...options,
      signal: controller.signal,
    });

    const created = nowUnixSeconds();
    const completionId = sessionId || randomId('chatcmpl');
    const model = stdReq.responseModel;
    const stripMarkers = this.stripReferenceMarkers;
    const includeUsage = params.stream_options?.include_usage !== false;

    const makeGenerator = async function* (
      engine: ExecutionEngine,
    ): AsyncGenerator<ChatCompletionChunk, void, void> {
      let currentType: 'thinking' | 'text' = stdReq.thinking
        ? FragmentTypeConst.THINKING
        : FragmentTypeConst.TEXT;
      let firstChunkSent = false;
      let thinkingAcc = '';
      let textAcc = '';
      let finishReason: 'stop' | 'tool_calls' | 'content_filter' = FinishReasonConst.STOP;
      const useSieve = stdReq.toolNames.length > 0 && stdReq.toolChoice.mode !== 'none';
      const sieveState = createToolSieveState();
      const toolIdStore = new Map<number, string>();
      let sawToolCalls = false;

      const makeDeltaChunk = (
        delta: ChatCompletionChunk['choices'][0]['delta'],
      ): ChatCompletionChunk => {
        const d = { ...delta };
        if (!firstChunkSent) {
          d.role = MessageRole.ASSISTANT;
          firstChunkSent = true;
        }
        return {
          id: completionId,
          object: OpenAIObjectType.CHAT_COMPLETION_CHUNK,
          created,
          model,
          choices: [{ index: 0, delta: d, finish_reason: null }],
        };
      };

      const emitSieveEvents = function* (events: ToolSieveEvent[]): Generator<ChatCompletionChunk> {
        for (const ev of events) {
          if (ev.type === 'text' && ev.text) {
            yield makeDeltaChunk({ content: ev.text });
          } else if (ev.type === 'tool_calls' && ev.calls.length > 0) {
            sawToolCalls = true;
            yield makeDeltaChunk({
              tool_calls: formatOpenAIStreamToolCalls(ev.calls, toolIdStore, stdReq.toolsRaw),
            });
          }
        }
      };

      try {
        for await (const rawFrame of iterateSSEDataPayloads(response.body!, controller.signal)) {
          const parsed = parseChunkForContent(rawFrame, stdReq.thinking, currentType, stripMarkers);
          if (!parsed.parsed) continue;
          if (parsed.errorMessage) {
            throw APIError.generate(
              500,
              { message: parsed.errorMessage },
              parsed.errorMessage,
              undefined,
            );
          }
          if (parsed.contentFilter) {
            finishReason = FinishReasonConst.CONTENT_FILTER;
            break;
          }
          currentType = parsed.newType;

          for (const part of parsed.parts) {
            if (part.type === FragmentTypeConst.THINKING) {
              const delta = trimContinuationOverlap(thinkingAcc, part.text);
              if (!delta) continue;
              thinkingAcc += delta;
              yield makeDeltaChunk({ reasoning_content: delta });
            } else {
              const delta = trimContinuationOverlap(textAcc, part.text);
              if (!delta) continue;
              textAcc += delta;
              if (!useSieve) {
                yield makeDeltaChunk({ content: delta });
              } else {
                yield* emitSieveEvents(processToolSieveChunk(sieveState, delta, stdReq.toolNames));
              }
            }
          }

          if (parsed.finished) {
            break;
          }
        }

        if (useSieve) {
          yield* emitSieveEvents(flushToolSieve(sieveState, stdReq.toolNames));
        }

        if (sawToolCalls) {
          finishReason = FinishReasonConst.TOOL_CALLS;
        }

        const usage = buildUsage(stdReq.finalPrompt, thinkingAcc, textAcc);
        yield {
          id: completionId,
          object: OpenAIObjectType.CHAT_COMPLETION_CHUNK,
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          ...(includeUsage ? { usage } : {}),
        };
      } finally {
        void engine.scheduleAutoDelete(auth, sessionId);
      }
    };

    return new Stream(() => makeGenerator(this), controller);
  }

  public async executeTextCompletion(
    params: CompletionCreateParamsBase,
    options?: RequestOptions,
  ): Promise<Completion> {
    const stdReq = normalizeOpenAIRequest(
      RequestPayloadAdapter.fromCompletionParams(params),
      RequestSurfaceConst.OPENAI_COMPLETIONS,
      this.modelAliases,
    );
    const turn = await this.collectTurn(stdReq, options);
    return OpenAIResponseFactory.createTextCompletion(stdReq, turn);
  }

  private static extractResponseInputItems(rawPayload: JsonObject): JsonValue[] {
    if (typeof rawPayload.input === 'string') {
      return [
        {
          type: 'message',
          role: MessageRole.USER,
          content: [{ type: 'input_text', text: rawPayload.input }],
        },
      ];
    }
    if (Array.isArray(rawPayload.input)) {
      return [...rawPayload.input];
    }
    if (Array.isArray(rawPayload.messages)) {
      return [...rawPayload.messages];
    }
    return [];
  }

  public async executeResponsesNonStream(
    params: ResponseCreateParams,
    options?: RequestOptions,
  ): Promise<ResponseObject> {
    const rawPayload = RequestPayloadAdapter.fromResponsesParams(params);
    const stdReq = normalizeOpenAIRequest(
      rawPayload,
      RequestSurfaceConst.OPENAI_RESPONSES,
      this.modelAliases,
    );
    const turn = await this.collectTurn(stdReq, options);
    const responseObj = OpenAIResponseFactory.createResponseObject(stdReq, turn);
    const inputItems = ExecutionEngine.extractResponseInputItems(rawPayload);

    setBoundedStoreEntry(this.responsesStore, responseObj.id, {
      response: responseObj,
      inputItems,
    });
    return responseObj;
  }

  public async executeResponsesStream(
    params: ResponseCreateParams,
    options?: RequestOptions,
  ): Promise<Stream<ResponseStreamEvent>> {
    const stdReq = normalizeOpenAIRequest(
      RequestPayloadAdapter.fromResponsesParams(params),
      RequestSurfaceConst.OPENAI_RESPONSES,
      this.modelAliases,
    );
    const controller = createLinkedAbortController(options?.signal);

    const { auth, sessionId, response } = await this.startUpstreamCompletion(stdReq, {
      ...options,
      signal: controller.signal,
    });

    const responseId = randomId('resp');
    const msgId = randomId('msg');
    const created = nowUnixSeconds();
    const model = stdReq.responseModel;
    const stripMarkers = this.stripReferenceMarkers;

    const makeGenerator = async function* (
      engine: ExecutionEngine,
    ): AsyncGenerator<ResponseStreamEvent, void, void> {
      let currentType: 'thinking' | 'text' = stdReq.thinking ? 'thinking' : 'text';
      let thinkingAcc = '';
      let textAcc = '';
      const useSieve = stdReq.toolNames.length > 0 && stdReq.toolChoice.mode !== 'none';
      const sieveState = createToolSieveState();
      const detectedCalls: ParsedToolCall[] = [];

      const emitResponseSieveEvents = function* (
        events: ToolSieveEvent[],
      ): Generator<ResponseStreamEvent> {
        for (const ev of events) {
          if (ev.type === 'text' && ev.text) {
            yield {
              type: 'response.output_text.delta',
              item_id: msgId,
              output_index: 0,
              content_index: 0,
              delta: ev.text,
            };
          } else if (ev.type === 'tool_calls') {
            detectedCalls.push(...ev.calls);
          }
        }
      };

      yield {
        type: 'response.created',
        response: {
          id: responseId,
          type: 'response',
          object: 'response',
          created_at: created,
          status: 'in_progress',
          model,
          output: [],
          output_text: '',
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
      };

      try {
        for await (const rawFrame of iterateSSEDataPayloads(response.body!, controller.signal)) {
          const parsed = parseChunkForContent(rawFrame, stdReq.thinking, currentType, stripMarkers);
          if (!parsed.parsed) continue;
          if (parsed.errorMessage) {
            throw APIError.generate(
              500,
              { message: parsed.errorMessage },
              parsed.errorMessage,
              undefined,
            );
          }
          if (parsed.contentFilter) {
            break;
          }
          currentType = parsed.newType;

          for (const part of parsed.parts) {
            if (part.type === 'thinking') {
              const delta = trimContinuationOverlap(thinkingAcc, part.text);
              if (!delta) continue;
              thinkingAcc += delta;
              yield {
                type: 'response.reasoning_summary_text.delta',
                item_id: msgId,
                output_index: 0,
                delta,
              };
            } else {
              const delta = trimContinuationOverlap(textAcc, part.text);
              if (!delta) continue;
              textAcc += delta;
              if (!useSieve) {
                yield {
                  type: 'response.output_text.delta',
                  item_id: msgId,
                  output_index: 0,
                  content_index: 0,
                  delta,
                };
              } else {
                yield* emitResponseSieveEvents(
                  processToolSieveChunk(sieveState, delta, stdReq.toolNames),
                );
              }
            }
          }

          if (parsed.finished) break;
        }

        if (useSieve) {
          yield* emitResponseSieveEvents(flushToolSieve(sieveState, stdReq.toolNames));
        }

        const output: ResponseOutputItem[] = [];
        let exposedOutputText = textAcc;

        if (detectedCalls.length > 0) {
          exposedOutputText = '';
          const formattedCalls = formatOpenAIToolCalls(detectedCalls, stdReq.toolsRaw);
          for (let i = 0; i < formattedCalls.length; i++) {
            const tc = formattedCalls[i];
            const itemId = randomId('fc');
            yield {
              type: 'response.function_call_arguments.delta',
              item_id: itemId,
              output_index: i,
              call_id: tc.id,
              name: tc.function.name,
              delta: tc.function.arguments,
            };
            yield {
              type: 'response.function_call_arguments.done',
              item_id: itemId,
              output_index: i,
              call_id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
            };
            output.push({
              id: itemId,
              type: 'function_call',
              call_id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
              status: 'completed',
            });
          }
        } else {
          const content: ResponseOutputItemMessageContent[] = [];
          if (thinkingAcc) content.push({ type: 'reasoning', text: thinkingAcc });
          if (textAcc) content.push({ type: 'output_text', text: textAcc });
          output.push({
            id: msgId,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content,
          });
          yield {
            type: 'response.output_text.done',
            item_id: msgId,
            output_index: 0,
            content_index: 0,
            text: textAcc,
          };
        }

        const completedResponse: ResponseObject = {
          id: responseId,
          type: 'response',
          object: 'response',
          created_at: created,
          status: 'completed',
          model,
          output,
          output_text: exposedOutputText,
          usage: toResponseUsage(buildUsage(stdReq.finalPrompt, thinkingAcc, textAcc)),
        };

        setBoundedStoreEntry(engine.responsesStore, responseId, {
          response: completedResponse,
          inputItems: [],
        });

        yield {
          type: 'response.completed',
          response: completedResponse,
        };
      } finally {
        void engine.scheduleAutoDelete(auth, sessionId);
      }
    };

    return new Stream(() => makeGenerator(this), controller);
  }
}
