/**
 * DeepSeek-Backed OpenAI SDK Resource Namespaces & Methods Implementation.
 * Implements the OpenAI resource namespaces natively supported by DeepSeek Web API:
 * - `chat.completions` (including `.stream()`, `.parse()`, `.runTools()`, `.messages`)
 * - `completions`
 * - `responses` (including `.stream()`, `.parse()`, `.inputItems`)
 * - `models` (including `.listConfigs()`)
 * - `files` & `uploads`
 * - `beta` (`beta.chat.completions`, `beta.assistants`, `beta.threads`)
 *
 * Design Patterns Applied:
 * - Repository / Resource Facade Pattern across supported OpenAI API namespaces
 * - Declarative pattern matching via `ts-pattern` (`match`)
 * - Strict TypeScript domain models with zero `any` and zero `unknown`
 */

import { match } from 'ts-pattern';
import {
  DEEPSEEK_MODELS,
  getModelType,
  HttpHeader,
  MessageRole,
  MimeType,
  ModelObject,
  ModelTypeConst,
  OpenAIObjectType,
  resolveModel,
  ServerModelConfig,
} from '../protocol/constants.js';
import {
  APIPromise,
  createLinkedAbortController,
  NotFoundError,
  Page,
  RequestOptions,
  Stream,
} from './core.js';
import { ChatCompletionStream } from './chat-stream-helper.js';
import { ExecutionEngine, setBoundedStoreEntry } from './engine.js';
import {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsBase,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  Completion,
  CompletionCreateParamsBase,
  CustomFilePayload,
  FileCreateParams,
  FileDeleted,
  FileObject,
  ParsedChatCompletion,
  ResponseCreateParams,
  ResponseCreateParamsBase,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseObject,
  ResponseStreamEvent,
  ResponseToolDefinition,
  ToolArgumentParser,
  ToolRunnableCallback,
  Uploadable,
} from './types.js';
import { ChatUsage } from '../sse/parser.js';
import {
  JsonObject,
  JsonValue,
  nowUnixSeconds,
  QueryRecord,
  randomId,
  safeJsonParseObject,
  StringRecord,
} from '../types/json.js';

function requireEntry<V>(map: Map<string, V> | undefined, id: string, label: string): V {
  const found = map?.get(id);
  if (!found) {
    throw new NotFoundError(404, { message: `${label} '${id}' not found.` });
  }
  return found;
}

function tryParseJson<T = JsonValue>(raw: string | null | undefined): T | null {
  if (!raw || typeof raw !== 'string') return null;
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
  }
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

function isCustomFilePayload(val: Uploadable): val is CustomFilePayload {
  return (
    typeof val === 'object' &&
    val !== null &&
    'data' in val &&
    !(val instanceof Uint8Array) &&
    !(val instanceof ArrayBuffer) &&
    !(typeof Blob !== 'undefined' && val instanceof Blob)
  );
}

export class ChatCompletionsMessages {
  constructor(private readonly engine: ExecutionEngine) {}

  public list(
    completionId: string,
    _query?: QueryRecord,
    _options?: RequestOptions,
  ): APIPromise<Page<ChatCompletion['choices'][0]['message']>> {
    return APIPromise.from(async () => {
      const found = requireEntry(this.engine.chatCompletionsStore, completionId, 'Chat completion');
      return new Page(found.choices.map((c) => c.message));
    });
  }
}

export class ChatCompletions {
  public readonly messages: ChatCompletionsMessages;

  constructor(private readonly engine: ExecutionEngine) {
    this.messages = new ChatCompletionsMessages(engine);
  }

  public create(
    params: ChatCompletionCreateParamsNonStreaming,
    options?: RequestOptions,
  ): APIPromise<ChatCompletion>;
  public create(
    params: ChatCompletionCreateParamsStreaming,
    options?: RequestOptions,
  ): APIPromise<Stream<ChatCompletionChunk>>;
  public create(
    params: ChatCompletionCreateParams,
    options?: RequestOptions,
  ): APIPromise<ChatCompletion | Stream<ChatCompletionChunk>>;
  public create(
    params: ChatCompletionCreateParams,
    options?: RequestOptions,
  ): APIPromise<ChatCompletion | Stream<ChatCompletionChunk>> {
    return match(Boolean(params.stream))
      .with(true, () =>
        APIPromise.from<ChatCompletion | Stream<ChatCompletionChunk>>(() =>
          this.engine.executeChatCompletionStream(params, options),
        ),
      )
      .with(false, () =>
        APIPromise.from<ChatCompletion | Stream<ChatCompletionChunk>>(() =>
          this.engine.executeChatCompletionNonStream(params, options),
        ),
      )
      .exhaustive();
  }

  public parse<ParsedT = JsonValue>(
    params: ChatCompletionCreateParamsNonStreaming,
    options?: RequestOptions,
  ): APIPromise<ParsedChatCompletion<ParsedT>> {
    return APIPromise.from(async () => {
      const reqParams: ChatCompletionCreateParamsNonStreaming = {
        ...params,
        stream: false,
        response_format: params.response_format ?? { type: 'json_object' },
      };
      const completion = await this.engine.executeChatCompletionNonStream(reqParams, options);
      const choices = completion.choices.map((c) => ({
        ...c,
        message: {
          ...c.message,
          parsed: tryParseJson<ParsedT>(c.message.content),
        },
      }));
      return {
        ...completion,
        choices,
      };
    });
  }

  public stream(
    params: ChatCompletionCreateParamsBase,
    options?: RequestOptions,
  ): ChatCompletionStream {
    const controller = createLinkedAbortController(options?.signal);
    const streamParams: ChatCompletionCreateParamsStreaming = {
      ...params,
      stream: true,
    };
    const promptText = JSON.stringify(params.messages ?? '');
    const lazyStream = new Stream<ChatCompletionChunk>(() => {
      let innerIter: AsyncIterator<ChatCompletionChunk> | null = null;
      return {
        next: async () => {
          if (!innerIter) {
            const s = await this.engine.executeChatCompletionStream(streamParams, {
              ...options,
              signal: controller.signal,
            });
            innerIter = s[Symbol.asyncIterator]();
          }
          return innerIter.next();
        },
      };
    }, controller);

    return new ChatCompletionStream(lazyStream, promptText);
  }

  /**
   * Automatic tool runner loop matching OpenAI SDK's `chat.completions.runTools()`.
   * Executes any tool in `params.tools` that provides a `function.function` callback.
   */
  public runTools(
    params: ChatCompletionCreateParamsBase,
    options?: RequestOptions & { maxChatCompletions?: number },
  ): ChatCompletionStream {
    const maxLoops = options?.maxChatCompletions ?? 10;
    const controller = createLinkedAbortController(options?.signal);

    const toolMap = new Map<
      string,
      {
        callback: ToolRunnableCallback;
        parse?: ToolArgumentParser;
      }
    >();

    for (const tool of params.tools ?? []) {
      if (tool?.type === 'function' && typeof tool.function?.function === 'function') {
        toolMap.set(tool.function.name, {
          callback: tool.function.function,
          parse: tool.function.parse,
        });
      }
    }

    const makeLoopGenerator = async function* (
      self: ChatCompletions,
    ): AsyncGenerator<ChatCompletionChunk, void, void> {
      const messages: ChatCompletionMessageParam[] = [...(params.messages ?? [])];
      for (let step = 0; step < maxLoops; step++) {
        const comp = await self.engine.executeChatCompletionNonStream(
          {
            ...params,
            messages,
            stream: false,
          },
          { ...options, signal: controller.signal },
        );

        const choice = comp.choices[0];
        const msg = choice.message;
        yield {
          id: comp.id,
          object: OpenAIObjectType.CHAT_COMPLETION_CHUNK,
          created: comp.created,
          model: comp.model,
          choices: [
            {
              index: 0,
              delta: {
                role: MessageRole.ASSISTANT,
                content: msg.content,
                reasoning_content: msg.reasoning_content,
                tool_calls: msg.tool_calls?.map((tc, idx) => ({
                  index: idx,
                  id: tc.id,
                  type: MessageRole.FUNCTION,
                  function: tc.function,
                })),
              },
              finish_reason: choice.finish_reason,
            },
          ],
          usage: comp.usage,
        };

        if (!msg.tool_calls || msg.tool_calls.length === 0 || toolMap.size === 0) {
          break;
        }

        messages.push({
          role: MessageRole.ASSISTANT,
          content: msg.content,
          tool_calls: msg.tool_calls,
        });

        let executedAny = false;
        for (const tc of msg.tool_calls) {
          const runner = toolMap.get(tc.function.name);
          if (!runner) continue;
          executedAny = true;
          const parsedArgs: JsonObject = runner.parse
            ? runner.parse(tc.function.arguments)
            : (safeJsonParseObject(tc.function.arguments) ?? {});
          const result = await runner.callback(parsedArgs);
          messages.push({
            role: MessageRole.TOOL,
            tool_call_id: tc.id,
            content: typeof result === 'string' ? result : JSON.stringify(result ?? null),
          });
        }
        if (!executedAny) {
          break;
        }
      }
    };

    const outerStream = new Stream(() => makeLoopGenerator(this), controller);
    return new ChatCompletionStream(outerStream, JSON.stringify(params.messages ?? ''));
  }

  public retrieve(completionId: string, _options?: RequestOptions): APIPromise<ChatCompletion> {
    return APIPromise.from(async () =>
      requireEntry(this.engine.chatCompletionsStore, completionId, 'Chat completion'),
    );
  }

  public update(
    completionId: string,
    body: { metadata: StringRecord | null },
    _options?: RequestOptions,
  ): APIPromise<ChatCompletion> {
    return APIPromise.from(async () => {
      const found = requireEntry(this.engine.chatCompletionsStore, completionId, 'Chat completion');
      found.metadata = body.metadata;
      return found;
    });
  }

  public list(_query?: QueryRecord, _options?: RequestOptions): APIPromise<Page<ChatCompletion>> {
    return APIPromise.from(async () => {
      return new Page(Array.from(this.engine.chatCompletionsStore.values()));
    });
  }

  public del(
    completionId: string,
    options?: RequestOptions,
  ): APIPromise<{ id: string; object: 'chat.completion.deleted'; deleted: boolean }> {
    return APIPromise.from(async () => {
      const deletedLocal = this.engine.chatCompletionsStore.delete(completionId);
      try {
        const auth = await this.engine.ds.pool.acquire(options?.deepseekToken, options?.signal);
        await this.engine.ds.deleteSession(auth, completionId, options?.signal);
      } catch {
        // Ignore remote session deletion errors if ID was synthetic
      }
      return {
        id: completionId,
        object: 'chat.completion.deleted',
        deleted: deletedLocal || true,
      };
    });
  }

  public delete(
    completionId: string,
    options?: RequestOptions,
  ): APIPromise<{ id: string; object: 'chat.completion.deleted'; deleted: boolean }> {
    return this.del(completionId, options);
  }
}

export class Chat {
  public readonly completions: ChatCompletions;
  constructor(engine: ExecutionEngine) {
    this.completions = new ChatCompletions(engine);
  }
}

export class Completions {
  constructor(private readonly engine: ExecutionEngine) {}

  public create(
    params: CompletionCreateParamsBase,
    options?: RequestOptions,
  ): APIPromise<Completion> {
    return APIPromise.from(() => this.engine.executeTextCompletion(params, options));
  }
}

export class ResponsesInputItems {
  constructor(private readonly engine: ExecutionEngine) {}

  public list(
    responseId: string,
    _query?: QueryRecord,
    _options?: RequestOptions,
  ): APIPromise<Page<JsonValue>> {
    return APIPromise.from(async () => {
      const found = requireEntry(this.engine.responsesStore, responseId, 'Response');
      return new Page(found.inputItems);
    });
  }
}

export class Responses {
  public readonly inputItems: ResponsesInputItems;

  constructor(private readonly engine: ExecutionEngine) {
    this.inputItems = new ResponsesInputItems(engine);
  }

  public create(
    params: ResponseCreateParamsNonStreaming,
    options?: RequestOptions,
  ): APIPromise<ResponseObject>;
  public create(
    params: ResponseCreateParamsStreaming,
    options?: RequestOptions,
  ): APIPromise<Stream<ResponseStreamEvent>>;
  public create(
    params: ResponseCreateParams,
    options?: RequestOptions,
  ): APIPromise<ResponseObject | Stream<ResponseStreamEvent>>;
  public create(
    params: ResponseCreateParams,
    options?: RequestOptions,
  ): APIPromise<ResponseObject | Stream<ResponseStreamEvent>> {
    return match(Boolean(params.stream))
      .with(true, () =>
        APIPromise.from<ResponseObject | Stream<ResponseStreamEvent>>(() =>
          this.engine.executeResponsesStream(params, options),
        ),
      )
      .with(false, () =>
        APIPromise.from<ResponseObject | Stream<ResponseStreamEvent>>(() =>
          this.engine.executeResponsesNonStream(params, options),
        ),
      )
      .exhaustive();
  }

  public stream(
    params: ResponseCreateParamsBase,
    options?: RequestOptions,
  ): APIPromise<Stream<ResponseStreamEvent>> {
    return APIPromise.from(() =>
      this.engine.executeResponsesStream({ ...params, stream: true }, options),
    );
  }

  public parse<ParsedT = JsonValue>(
    params: ResponseCreateParamsNonStreaming,
    options?: RequestOptions,
  ): APIPromise<ResponseObject<ParsedT>> {
    return APIPromise.from(async () => {
      const resp = await this.engine.executeResponsesNonStream(
        {
          ...params,
          stream: false,
          text: params.text ?? { format: { type: 'json_object' } },
        },
        options,
      );
      return {
        ...resp,
        output_parsed: tryParseJson<ParsedT>(resp.output_text),
      };
    });
  }

  public retrieve(responseId: string, _options?: RequestOptions): APIPromise<ResponseObject> {
    return APIPromise.from(
      async () => requireEntry(this.engine.responsesStore, responseId, 'Response').response,
    );
  }

  public del(
    responseId: string,
    _options?: RequestOptions,
  ): APIPromise<{ id: string; object: 'response.deleted'; deleted: boolean }> {
    return APIPromise.from(async () => {
      if (!this.engine.responsesStore.delete(responseId)) {
        throw new NotFoundError(404, { message: `Response '${responseId}' not found.` });
      }
      return { id: responseId, object: 'response.deleted', deleted: true };
    });
  }

  public delete(
    responseId: string,
    options?: RequestOptions,
  ): APIPromise<{ id: string; object: 'response.deleted'; deleted: boolean }> {
    return this.del(responseId, options);
  }

  public cancel(responseId: string, _options?: RequestOptions): APIPromise<ResponseObject> {
    return APIPromise.from(async () => {
      const found = requireEntry(this.engine.responsesStore, responseId, 'Response');
      found.response.status = 'cancelled';
      return found.response;
    });
  }
}

export class Models {
  constructor(private readonly engine: ExecutionEngine) {}

  private async fetchSyncedModels(options?: RequestOptions): Promise<ModelObject[]> {
    const auth = await this.engine.ds.pool
      .acquire(options?.deepseekToken, options?.signal)
      .catch(() => undefined);
    const models = await this.engine.ds.getModels(auth, options?.signal);
    return models.length > 0 ? [...models] : [...DEEPSEEK_MODELS];
  }

  public list(options?: RequestOptions): APIPromise<Page<ModelObject>> {
    return APIPromise.from(async () => {
      const models = await this.fetchSyncedModels(options);
      return new Page(models);
    });
  }

  /**
   * Lists the raw upstream server model configurations from `/api/v0/client/settings?did=<deviceId>&scope=model`.
   */
  public listConfigs(options?: RequestOptions): APIPromise<Page<ServerModelConfig>> {
    return APIPromise.from(async () => {
      const auth = await this.engine.ds.pool
        .acquire(options?.deepseekToken, options?.signal)
        .catch(() => undefined);
      const configs = await this.engine.ds.getModelConfigs(auth, options?.signal);
      return new Page([...configs]);
    });
  }

  public retrieve(modelId: string, options?: RequestOptions): APIPromise<ModelObject> {
    return APIPromise.from(async () => {
      const models = await this.fetchSyncedModels(options);
      const { resolved, ok } = resolveModel(modelId, this.engine.modelAliases);
      if (!ok) {
        throw new NotFoundError(
          404,
          { message: 'Model not found.' },
          'Model not found.',
          undefined,
        );
      }
      return (
        models.find((m) => m.id === resolved) ?? {
          id: resolved,
          object: OpenAIObjectType.MODEL,
          created: 1677610602,
          owned_by: 'deepseek',
          permission: [],
        }
      );
    });
  }

  public del(
    modelId: string,
    _options?: RequestOptions,
  ): APIPromise<{ id: string; object: 'model'; deleted: boolean }> {
    return APIPromise.from(async () => ({
      id: modelId,
      object: OpenAIObjectType.MODEL,
      deleted: true,
    }));
  }

  public delete(
    modelId: string,
    options?: RequestOptions,
  ): APIPromise<{ id: string; object: 'model'; deleted: boolean }> {
    return this.del(modelId, options);
  }
}

export class Files {
  constructor(private readonly engine: ExecutionEngine) {}

  public create(params: FileCreateParams, options?: RequestOptions): APIPromise<FileObject> {
    return APIPromise.from(async () => {
      const auth = await this.engine.ds.pool.acquire(options?.deepseekToken, options?.signal);
      let filename = params.filename || 'upload.txt';
      let data: Uint8Array | ArrayBuffer | Blob | string;
      let rawBytes: Uint8Array = new Uint8Array(0);

      if (typeof File !== 'undefined' && params.file instanceof File) {
        filename = params.filename || params.file.name || filename;
        data = params.file;
        rawBytes = new Uint8Array(await params.file.arrayBuffer());
      } else if (typeof Blob !== 'undefined' && params.file instanceof Blob) {
        data = params.file;
        rawBytes = new Uint8Array(await params.file.arrayBuffer());
      } else if (isCustomFilePayload(params.file)) {
        if (params.file.name) filename = params.file.name;
        data = params.file.data;
        rawBytes =
          typeof params.file.data === 'string'
            ? new TextEncoder().encode(params.file.data)
            : new Uint8Array(params.file.data);
      } else {
        data = params.file;
        if (typeof params.file === 'string') {
          rawBytes = new TextEncoder().encode(params.file);
        } else if (params.file instanceof Uint8Array || params.file instanceof ArrayBuffer) {
          rawBytes = new Uint8Array(params.file);
        }
      }

      const modelType =
        params.model_type ||
        (params.model
          ? getModelType(resolveModel(params.model, this.engine.modelAliases).resolved)
          : ModelTypeConst.DEFAULT);

      const uploaded = await this.engine.ds.uploadFile(
        auth,
        {
          filename,
          contentType: params.contentType,
          purpose: params.purpose,
          modelType,
          data,
        },
        options?.signal,
      );

      const fileObj: FileObject = {
        id: uploaded.id,
        object: OpenAIObjectType.FILE,
        bytes: uploaded.bytes,
        created_at: nowUnixSeconds(),
        filename: uploaded.filename,
        purpose: uploaded.purpose || params.purpose,
        status: uploaded.status || 'uploaded',
        status_details: null,
        account_id: uploaded.accountId,
      };

      setBoundedStoreEntry(this.engine.filesStore, fileObj.id, {
        content: rawBytes,
        meta: fileObj,
      });

      return fileObj;
    });
  }

  public retrieve(fileId: string, options?: RequestOptions): APIPromise<FileObject> {
    return APIPromise.from(async () => {
      const local = this.engine.filesStore.get(fileId);
      try {
        const auth = await this.engine.ds.pool.acquire(options?.deepseekToken, options?.signal);
        const fetched = await this.engine.ds.fetchUploadedFile(auth, fileId, options?.signal);
        return {
          id: fetched.id,
          object: OpenAIObjectType.FILE,
          bytes: fetched.bytes,
          created_at: nowUnixSeconds(),
          filename: fetched.filename,
          purpose: fetched.purpose || 'assistants',
          status: fetched.status || 'processed',
          status_details: null,
          account_id: fetched.accountId,
        };
      } catch (err) {
        if (local) {
          return local.meta;
        }
        throw err;
      }
    });
  }

  public list(_query?: QueryRecord, _options?: RequestOptions): APIPromise<Page<FileObject>> {
    return APIPromise.from(async () => {
      const items = Array.from(this.engine.filesStore.values()).map((v) => v.meta);
      return new Page(items);
    });
  }

  public del(fileId: string, _options?: RequestOptions): APIPromise<FileDeleted> {
    return APIPromise.from(async () => {
      this.engine.filesStore.delete(fileId);
      return {
        id: fileId,
        object: OpenAIObjectType.FILE,
        deleted: true,
      };
    });
  }

  public delete(fileId: string, options?: RequestOptions): APIPromise<FileDeleted> {
    return this.del(fileId, options);
  }

  public content(fileId: string, _options?: RequestOptions): APIPromise<Response> {
    return APIPromise.from(async () => {
      const local = requireEntry(this.engine.filesStore, fileId, 'File');
      const copy = new Uint8Array(local.content.byteLength);
      copy.set(local.content);
      return new Response(copy.buffer as ArrayBuffer, {
        status: 200,
        headers: { [HttpHeader.CONTENT_TYPE]: MimeType.OCTET_STREAM },
      });
    });
  }

  public async waitForProcessing(
    id: string,
    options?: { pollInterval?: number; maxWait?: number } & RequestOptions,
  ): Promise<FileObject> {
    const pollInterval = options?.pollInterval ?? 500;
    const maxWait = options?.maxWait ?? 30000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      const file = await this.retrieve(id, options);
      if (file.status === 'processed' || file.status === 'uploaded' || file.status === 'success') {
        return file;
      }
      if (file.status === 'error' || file.status === 'failed') {
        throw new Error(`File '${id}' processing failed.`);
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }
    return this.retrieve(id, options);
  }
}

export class Uploads {
  private readonly uploads = new Map<
    string,
    { filename: string; purpose: string; bytes: number; parts: Uint8Array[] }
  >();

  constructor(private readonly files: Files) {}

  public create(
    params: { filename: string; purpose: string; bytes: number; mime_type: string },
    _options?: RequestOptions,
  ) {
    return APIPromise.from(async () => {
      const id = randomId('upload');
      setBoundedStoreEntry(this.uploads, id, {
        filename: params.filename,
        purpose: params.purpose,
        bytes: params.bytes,
        parts: [],
      });
      return {
        id,
        object: 'upload' as const,
        bytes: params.bytes,
        created_at: nowUnixSeconds(),
        filename: params.filename,
        purpose: params.purpose,
        status: 'pending' as const,
      };
    });
  }

  public addPart(
    uploadId: string,
    params: { data: Uint8Array | string },
    _options?: RequestOptions,
  ) {
    return APIPromise.from(async () => {
      const up = requireEntry(this.uploads, uploadId, 'Upload');
      const chunk =
        typeof params.data === 'string' ? new TextEncoder().encode(params.data) : params.data;
      up.parts.push(chunk);
      return {
        id: randomId('part'),
        object: 'upload.part' as const,
        created_at: nowUnixSeconds(),
        upload_id: uploadId,
      };
    });
  }

  public complete(uploadId: string, _params?: { part_ids?: string[] }, options?: RequestOptions) {
    return APIPromise.from(async () => {
      const up = requireEntry(this.uploads, uploadId, 'Upload');
      const totalLen = up.parts.reduce((acc, p) => acc + p.byteLength, 0);
      const merged = new Uint8Array(totalLen);
      let off = 0;
      for (const p of up.parts) {
        merged.set(p, off);
        off += p.byteLength;
      }
      const file = await this.files.create(
        {
          file: merged,
          filename: up.filename,
          purpose: up.purpose,
        },
        options,
      );
      return {
        id: uploadId,
        object: 'upload' as const,
        bytes: totalLen,
        created_at: nowUnixSeconds(),
        filename: up.filename,
        purpose: up.purpose,
        status: 'completed' as const,
        file,
      };
    });
  }

  public cancel(uploadId: string, _options?: RequestOptions) {
    return APIPromise.from(async () => {
      requireEntry(this.uploads, uploadId, 'Upload');
      this.uploads.delete(uploadId);
      return {
        id: uploadId,
        object: 'upload' as const,
        status: 'cancelled' as const,
      };
    });
  }
}

export interface AssistantObject {
  id: string;
  object: 'assistant';
  created_at: number;
  name: string | null;
  instructions: string | null;
  model: string;
  tools: ResponseToolDefinition[];
  metadata: StringRecord;
}

export class BetaAssistants {
  private readonly store = new Map<string, AssistantObject>();

  public create(
    params: {
      model: string;
      name?: string | null;
      instructions?: string | null;
      tools?: ResponseToolDefinition[];
      metadata?: StringRecord | null;
    },
    _options?: RequestOptions,
  ): APIPromise<AssistantObject> {
    return APIPromise.from(async () => {
      const asst: AssistantObject = {
        id: randomId('asst'),
        object: 'assistant',
        created_at: nowUnixSeconds(),
        name: params.name ?? null,
        instructions: params.instructions ?? null,
        model: params.model,
        tools: params.tools ?? [],
        metadata: params.metadata ?? {},
      };
      this.store.set(asst.id, asst);
      return asst;
    });
  }

  public retrieve(assistantId: string, _options?: RequestOptions): APIPromise<AssistantObject> {
    return APIPromise.from(async () => requireEntry(this.store, assistantId, 'Assistant'));
  }

  public update(
    assistantId: string,
    params: {
      model?: string;
      name?: string | null;
      instructions?: string | null;
      tools?: ResponseToolDefinition[];
      metadata?: StringRecord | null;
    },
    _options?: RequestOptions,
  ): APIPromise<AssistantObject> {
    return APIPromise.from(async () => {
      const a = requireEntry(this.store, assistantId, 'Assistant');
      if (params.model !== undefined) a.model = params.model;
      if (params.name !== undefined) a.name = params.name;
      if (params.instructions !== undefined) a.instructions = params.instructions;
      if (params.tools !== undefined) a.tools = params.tools;
      if (params.metadata !== undefined && params.metadata !== null) a.metadata = params.metadata;
      return a;
    });
  }

  public list(_query?: QueryRecord, _options?: RequestOptions): APIPromise<Page<AssistantObject>> {
    return APIPromise.from(async () => new Page(Array.from(this.store.values())));
  }

  public del(assistantId: string, _options?: RequestOptions) {
    return APIPromise.from(async () => {
      this.store.delete(assistantId);
      return { id: assistantId, object: 'assistant.deleted' as const, deleted: true };
    });
  }

  public delete(assistantId: string, options?: RequestOptions) {
    return this.del(assistantId, options);
  }
}

export interface ThreadMessageObject {
  id: string;
  object: 'thread.message';
  created_at: number;
  thread_id: string;
  role: 'user' | 'assistant';
  content: Array<{ type: 'text'; text: { value: string; annotations: JsonObject[] } }>;
  metadata: StringRecord;
}

export class BetaThreadsMessages {
  public readonly messagesByThread = new Map<string, ThreadMessageObject[]>();

  public create(
    threadId: string,
    params: {
      role: 'user' | 'assistant';
      content: string | JsonValue[];
      metadata?: StringRecord | null;
    },
    _options?: RequestOptions,
  ): APIPromise<ThreadMessageObject> {
    return APIPromise.from(async () => {
      let list = this.messagesByThread.get(threadId);
      if (!list) {
        list = [];
        this.messagesByThread.set(threadId, list);
      }
      const text =
        typeof params.content === 'string' ? params.content : JSON.stringify(params.content);
      const msg: ThreadMessageObject = {
        id: randomId('msg'),
        object: 'thread.message',
        created_at: nowUnixSeconds(),
        thread_id: threadId,
        role: params.role,
        content: [{ type: 'text', text: { value: text, annotations: [] } }],
        metadata: params.metadata ?? {},
      };
      list.push(msg);
      return msg;
    });
  }

  public retrieve(
    threadId: string,
    messageId: string,
    _options?: RequestOptions,
  ): APIPromise<ThreadMessageObject> {
    return APIPromise.from(async () => {
      const list = this.messagesByThread.get(threadId) ?? [];
      const found = list.find((m) => m.id === messageId);
      if (!found) throw new NotFoundError(404, { message: `Message '${messageId}' not found.` });
      return found;
    });
  }

  public list(
    threadId: string,
    _query?: QueryRecord,
    _options?: RequestOptions,
  ): APIPromise<Page<ThreadMessageObject>> {
    return APIPromise.from(async () => new Page([...(this.messagesByThread.get(threadId) ?? [])]));
  }

  public del(threadId: string, messageId: string, _options?: RequestOptions) {
    return APIPromise.from(async () => {
      const list = this.messagesByThread.get(threadId) ?? [];
      this.messagesByThread.set(
        threadId,
        list.filter((m) => m.id !== messageId),
      );
      return { id: messageId, object: 'thread.message.deleted' as const, deleted: true };
    });
  }

  public delete(threadId: string, messageId: string, options?: RequestOptions) {
    return this.del(threadId, messageId, options);
  }
}

export interface ThreadRunObject {
  id: string;
  object: 'thread.run';
  created_at: number;
  thread_id: string;
  assistant_id: string;
  status: 'completed' | 'in_progress' | 'cancelled' | 'failed';
  model: string;
  usage?: ChatUsage;
}

export class BetaThreadsRuns {
  private readonly runs = new Map<string, ThreadRunObject>();

  constructor(
    private readonly engine: ExecutionEngine,
    private readonly assistants: BetaAssistants,
    private readonly messages: BetaThreadsMessages,
  ) {}

  public create(
    threadId: string,
    params: { assistant_id: string; model?: string; instructions?: string | null },
    options?: RequestOptions,
  ): APIPromise<ThreadRunObject> {
    return APIPromise.from(async () => {
      let model = params.model || 'deepseek-v4-flash';
      let instructions = params.instructions ?? '';
      try {
        const asst = await this.assistants.retrieve(params.assistant_id);
        if (!params.model && typeof asst.model === 'string') model = asst.model;
        if (!instructions && typeof asst.instructions === 'string')
          instructions = asst.instructions;
      } catch {
        // Use fallback model
      }

      const threadMsgs = this.messages.messagesByThread.get(threadId) ?? [];
      const chatMessages: ChatCompletionMessageParam[] = [];
      if (instructions) {
        chatMessages.push({ role: 'system', content: instructions });
      }
      for (const m of threadMsgs) {
        const textVal = m.content[0]?.text?.value ?? '';
        chatMessages.push({
          role: m.role || 'user',
          content: textVal,
        });
      }
      if (chatMessages.length === 0) {
        chatMessages.push({ role: 'user', content: 'Hello' });
      }

      const comp = await this.engine.executeChatCompletionNonStream(
        { model, messages: chatMessages, stream: false },
        options,
      );
      const replyText = comp.choices[0]?.message?.content ?? '';
      await this.messages.create(threadId, { role: 'assistant', content: replyText });

      const run: ThreadRunObject = {
        id: randomId('run'),
        object: 'thread.run',
        created_at: nowUnixSeconds(),
        thread_id: threadId,
        assistant_id: params.assistant_id,
        status: 'completed',
        model,
        usage: comp.usage,
      };
      this.runs.set(run.id, run);
      return run;
    });
  }

  public createAndPoll(
    threadId: string,
    params: { assistant_id: string; model?: string; instructions?: string | null },
    options?: RequestOptions,
  ): APIPromise<ThreadRunObject> {
    return this.create(threadId, params, options);
  }

  public retrieve(
    _threadId: string,
    runId: string,
    _options?: RequestOptions,
  ): APIPromise<ThreadRunObject> {
    return APIPromise.from(async () => requireEntry(this.runs, runId, 'Run'));
  }
}

export interface ThreadObject {
  id: string;
  object: 'thread';
  created_at: number;
  metadata: StringRecord | null;
}

export class BetaThreads {
  private readonly store = new Map<string, ThreadObject>();
  public readonly messages = new BetaThreadsMessages();
  public readonly runs: BetaThreadsRuns;

  constructor(engine: ExecutionEngine, assistants: BetaAssistants) {
    this.runs = new BetaThreadsRuns(engine, assistants, this.messages);
  }

  public create(
    params?: {
      messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
      metadata?: StringRecord | null;
    },
    _options?: RequestOptions,
  ): APIPromise<ThreadObject> {
    return APIPromise.from(async () => {
      const thread: ThreadObject = {
        id: randomId('thread'),
        object: 'thread',
        created_at: nowUnixSeconds(),
        metadata: params?.metadata ?? {},
      };
      this.store.set(thread.id, thread);
      for (const m of params?.messages ?? []) {
        await this.messages.create(thread.id, m);
      }
      return thread;
    });
  }

  public retrieve(threadId: string, _options?: RequestOptions): APIPromise<ThreadObject> {
    return APIPromise.from(async () => requireEntry(this.store, threadId, 'Thread'));
  }

  public update(
    threadId: string,
    params: { metadata?: StringRecord | null },
    _options?: RequestOptions,
  ): APIPromise<ThreadObject> {
    return APIPromise.from(async () => {
      const t = requireEntry(this.store, threadId, 'Thread');
      if (params.metadata !== undefined) t.metadata = params.metadata;
      return t;
    });
  }

  public del(threadId: string, _options?: RequestOptions) {
    return APIPromise.from(async () => {
      this.store.delete(threadId);
      this.messages.messagesByThread.delete(threadId);
      return { id: threadId, object: 'thread.deleted' as const, deleted: true };
    });
  }

  public delete(threadId: string, options?: RequestOptions) {
    return this.del(threadId, options);
  }

  public createAndRun(
    params: {
      assistant_id: string;
      thread?: { messages?: Array<{ role: 'user' | 'assistant'; content: string }> };
      model?: string;
      instructions?: string | null;
    },
    options?: RequestOptions,
  ): APIPromise<ThreadRunObject> {
    return APIPromise.from(async () => {
      const thread = await this.create(params.thread, options);
      return this.runs.create(
        thread.id,
        {
          assistant_id: params.assistant_id,
          model: params.model,
          instructions: params.instructions,
        },
        options,
      );
    });
  }

  public createAndRunPoll(
    params: {
      assistant_id: string;
      thread?: { messages?: Array<{ role: 'user' | 'assistant'; content: string }> };
      model?: string;
      instructions?: string | null;
    },
    options?: RequestOptions,
  ): APIPromise<ThreadRunObject> {
    return this.createAndRun(params, options);
  }
}

export class Beta {
  public readonly chat: { completions: ChatCompletions };
  public readonly assistants: BetaAssistants;
  public readonly threads: BetaThreads;

  constructor(engine: ExecutionEngine, chatCompletions: ChatCompletions) {
    this.chat = { completions: chatCompletions };
    this.assistants = new BetaAssistants();
    this.threads = new BetaThreads(engine, this.assistants);
  }
}
