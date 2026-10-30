/**
 * Main OpenAI-Compatible Client for DeepSeek Web API (`ds2api`).
 *
 * Works seamlessly across:
 * - Node.js (18+)
 * - Bun
 * - Cloudflare Workers / WinterCG Edge runtimes
 * - Deno
 *
 * Design Patterns Applied:
 * - Facade Pattern (`OpenAI` client unifying all 15 resource namespaces & Edge runtime adapter)
 * - Router / Command Pattern (`EdgeHttpRouter` using `ts-pattern` `match` for `/v1/*` routing)
 */

import { match, P } from 'ts-pattern';
import { AccountPool, DeepSeekAccount } from '../auth/account-pool.js';
import { DeepSeekClient } from '../deepseek/client.js';
import {
  DEEPSEEK_BASE_URL,
  DefaultTokenCache,
  HttpHeader,
  HttpMethod,
  MimeType,
  OpenAIObjectType,
  SessionCleanupMode,
  SSEConst,
} from '../protocol/constants.js';
import {
  APIError,
  APIPromise,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  OpenAIError,
  RequestOptions,
} from './core.js';
import { ExecutionEngine } from './engine.js';
import { Beta, Chat, Completions, Files, Models, Responses, Uploads } from './resources.js';
import {
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  CompletionCreateParamsBase,
  CustomFilePayload,
  FileCreateParams,
  OpenAIClientOptions,
  ResponseCreateParams,
  ResponseStreamEvent,
  Uploadable,
} from './types.js';
import { JsonObject, JsonValue, safeJsonParseObject, StringRecord } from '../types/json.js';
import type { GlobalWithProcess } from '../@types/openai.js';

function readEnv(name: string): string | undefined {
  try {
    const g = globalThis as GlobalWithProcess;
    const val = g.process?.env?.[name];
    if (typeof val === 'string') {
      return val;
    }
  } catch {
    // Ignore in restricted edge sandboxes
  }
  return undefined;
}

const CORS_HEADERS: StringRecord = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, OpenAI-Beta',
};

function jsonResponse(
  data: object | JsonValue,
  status = 200,
  extraHeaders?: StringRecord,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      [HttpHeader.CONTENT_TYPE]: MimeType.JSON_UTF8,
      ...CORS_HEADERS,
      ...(extraHeaders ?? {}),
    },
  });
}

function sseResponse(stream: ReadableStream<Uint8Array>, extraHeaders?: StringRecord): Response {
  return new Response(stream, {
    status: 200,
    headers: {
      [HttpHeader.CONTENT_TYPE]: MimeType.SSE_UTF8,
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...CORS_HEADERS,
      ...(extraHeaders ?? {}),
    },
  });
}

function encodeSSEStream<T>(
  items: AsyncIterable<T>,
  formatItem: (item: T) => string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const item of items) {
          controller.enqueue(encoder.encode(formatItem(item)));
        }
        controller.enqueue(encoder.encode(`${SSEConst.DATA_PREFIX} ${SSEConst.DONE_MARKER}\n\n`));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

function encodeChatSSEStream(
  chunks: AsyncIterable<ChatCompletionChunk>,
): ReadableStream<Uint8Array> {
  return encodeSSEStream(chunks, (chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
}

function encodeResponsesSSEStream(
  events: AsyncIterable<ResponseStreamEvent>,
): ReadableStream<Uint8Array> {
  return encodeSSEStream(events, (ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
}

function headersToRecord(headers: Headers): StringRecord {
  const rec: StringRecord = {};
  headers.forEach((value, key) => {
    rec[key] = value;
  });
  return rec;
}

function isAsyncIterableBytes(
  value: Uploadable | Response | AsyncIterable<Uint8Array>,
): value is AsyncIterable<Uint8Array> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

function isCustomFileObject(
  value: Uploadable | Response | AsyncIterable<Uint8Array>,
): value is CustomFilePayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    !(value instanceof Uint8Array) &&
    !(value instanceof ArrayBuffer) &&
    !(typeof Blob !== 'undefined' && value instanceof Blob) &&
    !(typeof Response !== 'undefined' && value instanceof Response)
  );
}

function createFileOrBlob(
  part: BlobPart,
  fileName: string,
  mimeType: string,
  lastModified?: number,
): File | Blob {
  if (typeof File !== 'undefined') {
    return new File([part], fileName, { type: mimeType, lastModified });
  }
  return new Blob([part], { type: mimeType });
}

/**
 * Helper to convert strings, Uint8Arrays, ArrayBuffers, Blobs, or Responses into an uploadable `File`/`Blob`.
 * Compatible with `import { toFile } from 'openai'`.
 */
export async function toFile(
  value: Uploadable | Response | AsyncIterable<Uint8Array>,
  name?: string | null,
  options?: { type?: string; lastModified?: number },
): Promise<File | Blob> {
  const fileName = name ?? 'upload.bin';
  const mimeType = options?.type ?? MimeType.OCTET_STREAM;

  if (typeof File !== 'undefined' && value instanceof File) {
    return value;
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return createFileOrBlob(value, fileName, value.type || mimeType, options?.lastModified);
  }
  if (typeof Response !== 'undefined' && value instanceof Response) {
    const buf = await value.arrayBuffer();
    return createFileOrBlob(buf, fileName, mimeType, options?.lastModified);
  }
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value);
    const ab = bytes.slice().buffer as ArrayBuffer;
    return createFileOrBlob(ab, fileName, mimeType, options?.lastModified);
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const ab: ArrayBuffer =
      value instanceof Uint8Array ? (value.slice().buffer as ArrayBuffer) : value;
    return createFileOrBlob(ab, fileName, mimeType, options?.lastModified);
  }
  if (isAsyncIterableBytes(value)) {
    const parts: Uint8Array[] = [];
    for await (const chunk of value) {
      parts.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
    let total = 0;
    for (const p of parts) total += p.byteLength;
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      merged.set(p, offset);
      offset += p.byteLength;
    }
    const ab = merged.buffer as ArrayBuffer;
    return createFileOrBlob(ab, fileName, mimeType, options?.lastModified);
  }
  if (isCustomFileObject(value)) {
    return toFile(value.data, value.name ?? fileName, {
      type: value.type ?? mimeType,
      lastModified: options?.lastModified,
    });
  }
  throw new BadRequestError(400, { message: 'Unsupported file input passed to toFile()' });
}

function resolveErrorType(
  err: Error | object | string | number | boolean | null | undefined,
): string {
  if (err instanceof APIError) {
    return err.type ?? 'api_error';
  }
  if (err instanceof OpenAIError) {
    return 'api_error';
  }
  return 'internal_server_error';
}

function resolveTokenCacheFile(options: OpenAIClientOptions): string | false {
  if (options.tokenCacheFile !== undefined) {
    return options.tokenCacheFile;
  }
  if (options.fetch) {
    return false;
  }
  return DefaultTokenCache.FILENAME;
}

function safeDecodePathSegment(rawSegment: string): string {
  try {
    return decodeURIComponent(rawSegment);
  } catch {
    throw new BadRequestError(400, {
      message: 'Malformed URI path segment.',
      type: 'invalid_request_error',
    });
  }
}

async function parseRequestJsonBody<T>(request: Request): Promise<T> {
  let rawText = '';
  try {
    rawText = await request.text();
  } catch {
    throw new BadRequestError(400, {
      message: 'Failed to read request body.',
      type: 'invalid_request_error',
    });
  }
  const parsed = safeJsonParseObject(rawText);
  if (!parsed) {
    throw new BadRequestError(400, {
      message: 'Request body must be a valid JSON object.',
      type: 'invalid_request_error',
    });
  }
  return parsed as T;
}

/**
 * Router Pattern: Declarative WinterCG Edge HTTP Router using `ts-pattern`.
 */
export class EdgeHttpRouter {
  constructor(private readonly client: Deepseek) {}

  public async dispatch(request: Request): Promise<Response> {
    if (request.method === HttpMethod.OPTIONS) {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url, 'https://ds2api.local');
    let pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (pathname.startsWith('/v1/')) {
      pathname = pathname.slice(3);
    } else if (pathname === '/v1') {
      pathname = '/';
    }

    const authHeader =
      request.headers.get(HttpHeader.AUTHORIZATION) ??
      request.headers.get(HttpHeader.AUTHORIZATION_LOWER);
    const bearerToken = authHeader?.replace(/^Bearer\s+/i, '').trim() || undefined;
    const reqOptions: RequestOptions = {
      signal: request.signal,
      deepseekToken: bearerToken,
      headers: bearerToken
        ? { [HttpHeader.AUTHORIZATION]: `${HttpHeader.BEARER_PREFIX}${bearerToken}` }
        : undefined,
    };

    try {
      return await match([request.method.toUpperCase(), pathname] as const)
        .with([HttpMethod.GET, P.union('/', '/health', '/healthz')], async () =>
          jsonResponse({ status: 'ok', service: 'ds2api' }),
        )
        .with([HttpMethod.GET, '/models'], async () => {
          const page = await this.client.models.list(reqOptions);
          return jsonResponse({ object: OpenAIObjectType.LIST, data: page.data });
        })
        .with([HttpMethod.GET, P.string.startsWith('/models/')], async ([, p]) => {
          const modelId = safeDecodePathSegment(p.slice('/models/'.length));
          const model = await this.client.models.retrieve(modelId, reqOptions);
          return jsonResponse(model);
        })
        .with([HttpMethod.POST, '/chat/completions'], async () => {
          const body = await parseRequestJsonBody<ChatCompletionCreateParams>(request);
          if (body.stream) {
            const stream = await this.client.chat.completions.create(
              { ...body, stream: true },
              reqOptions,
            );
            return sseResponse(encodeChatSSEStream(stream));
          }
          const completion = await this.client.chat.completions.create(
            { ...body, stream: false },
            reqOptions,
          );
          return jsonResponse(completion);
        })
        .with([HttpMethod.GET, '/chat/completions'], async () => {
          const page = await this.client.chat.completions.list(undefined, reqOptions);
          return jsonResponse({
            object: OpenAIObjectType.LIST,
            data: page.data,
            has_more: page.has_more,
          });
        })
        .with(
          [
            P.union(HttpMethod.GET, HttpMethod.POST, HttpMethod.DELETE),
            P.string.startsWith('/chat/completions/'),
          ],
          async ([method, p]) => {
            const rest = p.slice('/chat/completions/'.length);
            if (rest.endsWith('/messages') && method === HttpMethod.GET) {
              const id = safeDecodePathSegment(rest.slice(0, -'/messages'.length));
              const page = await this.client.chat.completions.messages.list(
                id,
                undefined,
                reqOptions,
              );
              return jsonResponse({
                object: OpenAIObjectType.LIST,
                data: page.data,
                has_more: page.has_more,
              });
            }
            const id = safeDecodePathSegment(rest);
            return match(method)
              .with(HttpMethod.GET, async () =>
                jsonResponse(await this.client.chat.completions.retrieve(id, reqOptions)),
              )
              .with(HttpMethod.POST, async () => {
                const body = await parseRequestJsonBody<{ metadata: StringRecord | null }>(request);
                return jsonResponse(
                  await this.client.chat.completions.update(id, body, reqOptions),
                );
              })
              .with(HttpMethod.DELETE, async () =>
                jsonResponse(await this.client.chat.completions.del(id, reqOptions)),
              )
              .exhaustive();
          },
        )
        .with([HttpMethod.POST, '/completions'], async () => {
          const body = await parseRequestJsonBody<CompletionCreateParamsBase>(request);
          const result = await this.client.completions.create(body, reqOptions);
          return jsonResponse(result);
        })
        .with([HttpMethod.POST, '/responses'], async () => {
          const body = await parseRequestJsonBody<ResponseCreateParams>(request);
          if (body.stream) {
            const stream = await this.client.responses.create(
              { ...body, stream: true },
              reqOptions,
            );
            return sseResponse(encodeResponsesSSEStream(stream));
          }
          const resp = await this.client.responses.create({ ...body, stream: false }, reqOptions);
          return jsonResponse(resp);
        })
        .with(
          [
            P.union(HttpMethod.GET, HttpMethod.POST, HttpMethod.DELETE),
            P.string.startsWith('/responses/'),
          ],
          async ([method, p]) => {
            const rest = p.slice('/responses/'.length);
            if (rest.endsWith('/input_items') && method === HttpMethod.GET) {
              const id = safeDecodePathSegment(rest.slice(0, -'/input_items'.length));
              const page = await this.client.responses.inputItems.list(id, undefined, reqOptions);
              return jsonResponse({
                object: OpenAIObjectType.LIST,
                data: page.data,
                has_more: page.has_more,
              });
            }
            if (rest.endsWith('/cancel') && method === HttpMethod.POST) {
              const id = safeDecodePathSegment(rest.slice(0, -'/cancel'.length));
              return jsonResponse(await this.client.responses.cancel(id, reqOptions));
            }
            const id = safeDecodePathSegment(rest);
            if (method === HttpMethod.GET) {
              return jsonResponse(await this.client.responses.retrieve(id, reqOptions));
            }
            if (method === HttpMethod.DELETE) {
              return jsonResponse(await this.client.responses.del(id, reqOptions));
            }
            throw new NotFoundError(404, {
              message: `Unknown endpoint: ${method} ${url.pathname}`,
              type: 'invalid_request_error',
            });
          },
        )
        .with([HttpMethod.GET, '/files'], async () => {
          const page = await this.client.files.list(undefined, reqOptions);
          return jsonResponse({
            object: OpenAIObjectType.LIST,
            data: page.data,
            has_more: page.has_more,
          });
        })
        .with([HttpMethod.POST, '/files'], async () => {
          const contentType = request.headers.get(HttpHeader.CONTENT_TYPE_LOWER) ?? '';
          if (contentType.includes(MimeType.MULTIPART_FORM)) {
            const form = await request.formData();
            const filePart = form.get('file');
            const purposePart = form.get('purpose');
            const purpose = typeof purposePart === 'string' ? purposePart : 'assistants';
            if (!filePart) {
              throw new BadRequestError(400, {
                message: 'Missing "file" field in multipart/form-data request',
              });
            }
            const created = await this.client.files.create({ file: filePart, purpose }, reqOptions);
            return jsonResponse(created);
          }
          const body = await parseRequestJsonBody<
            FileCreateParams & {
              filename?: string;
              content?: string;
            }
          >(request);
          const created = await this.client.files.create(
            {
              file: body.file ?? body.content ?? '',
              purpose: body.purpose ?? 'assistants',
              filename: body.filename,
            },
            reqOptions,
          );
          return jsonResponse(created);
        })
        .with(
          [P.union(HttpMethod.GET, HttpMethod.DELETE), P.string.startsWith('/files/')],
          async ([method, p]) => {
            const rest = p.slice('/files/'.length);
            if (rest.endsWith('/content') && method === HttpMethod.GET) {
              const id = safeDecodePathSegment(rest.slice(0, -'/content'.length));
              return await this.client.files.content(id, reqOptions);
            }
            const id = safeDecodePathSegment(rest);
            if (method === HttpMethod.GET) {
              return jsonResponse(await this.client.files.retrieve(id, reqOptions));
            }
            return jsonResponse(await this.client.files.del(id, reqOptions));
          },
        )
        .otherwise(() => {
          throw new NotFoundError(404, {
            message: `Unknown endpoint: ${request.method} ${url.pathname}`,
            type: 'invalid_request_error',
          });
        });
    } catch (err) {
      const status = err instanceof APIError ? (err.status ?? 500) : 500;
      const type = resolveErrorType(err as Error);
      const param = err instanceof APIError ? (err.param ?? null) : null;
      const code = err instanceof APIError ? (err.code ?? null) : null;
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse({ error: { message, type, param, code } }, status);
    }
  }
}

export class Deepseek {
  public apiKey: string;
  public organization: string | null;
  public project: string | null;
  public baseURL: string;
  public timeout: number;
  public maxRetries: number;
  public defaultHeaders?: StringRecord;
  public defaultQuery?: Record<string, string | undefined>;

  /** Underlying DeepSeek API client & PoW solver */
  public readonly deepseek: DeepSeekClient;
  /** Underlying execution engine */
  public readonly engine: ExecutionEngine;
  /** Declarative WinterCG Edge HTTP Router */
  public readonly router: EdgeHttpRouter;

  // ─── DeepSeek-Backed OpenAI SDK Resource Namespaces ──────────────────────
  public readonly chat: Chat;
  public readonly completions: Completions;
  public readonly responses: Responses;
  public readonly models: Models;
  public readonly files: Files;
  public readonly uploads: Uploads;
  public readonly beta: Beta;

  private readonly _options: OpenAIClientOptions;

  constructor(options: OpenAIClientOptions = {}) {
    this._options = { ...options };
    this.apiKey =
      options.apiKey ??
      readEnv('DEEPSEEK_TOKEN') ??
      readEnv('DS2API_KEY') ??
      readEnv('OPENAI_API_KEY') ??
      '';
    this.organization = options.organization ?? readEnv('OPENAI_ORG_ID') ?? null;
    this.project = options.project ?? readEnv('OPENAI_PROJECT_ID') ?? null;
    this.baseURL = options.baseURL ?? DEEPSEEK_BASE_URL;
    this.timeout = options.timeout ?? 120_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.defaultHeaders = options.defaultHeaders;
    this.defaultQuery = options.defaultQuery;

    const normalizedAccounts: DeepSeekAccount[] = [];
    for (const acc of options.accounts ?? []) {
      match(acc)
        .with(P.string, (strAcc) => {
          normalizedAccounts.push(...AccountPool.parseApiKeyInput(strAcc));
        })
        .with(P.nonNullable, (objAcc) => {
          normalizedAccounts.push({ ...objAcc });
        })
        .otherwise(() => {});
    }
    const allAccounts = AccountPool.parseApiKeyInput(this.apiKey || undefined, normalizedAccounts);
    const resolvedCacheFile = resolveTokenCacheFile(options);
    const pool = new AccountPool(allAccounts, undefined, undefined, resolvedCacheFile);

    this.deepseek = new DeepSeekClient({
      baseURL: this.baseURL,
      fetch: options.fetch,
      maxRetries: this.maxRetries,
      defaultHeaders: options.defaultHeaders,
      pool,
    });

    const autoDel: 'none' | 'single' | 'all' = match(options.autoDeleteSession)
      .with(true, () => SessionCleanupMode.SINGLE)
      .with(
        P.union(SessionCleanupMode.NONE, SessionCleanupMode.SINGLE, SessionCleanupMode.ALL),
        (mode) => mode,
      )
      .otherwise(() => SessionCleanupMode.NONE);

    this.engine = new ExecutionEngine({
      ds: this.deepseek,
      modelAliases: options.modelAliases,
      autoDeleteSessions: autoDel,
      stripReferenceMarkers: options.stripReferenceMarkers,
    });

    // Initialize DeepSeek-backed OpenAI resource namespaces
    this.files = new Files(this.engine);
    this.chat = new Chat(this.engine);
    this.completions = new Completions(this.engine);
    this.responses = new Responses(this.engine);
    this.models = new Models(this.engine);
    this.uploads = new Uploads(this.files);
    this.beta = new Beta(this.engine, this.chat.completions);
    this.router = new EdgeHttpRouter(this);
  }

  /**
   * Create a cloned client instance with overridden options (compatible with `client.withOptions(...)` in `openai`).
   */
  public withOptions(options: Partial<OpenAIClientOptions>): Deepseek {
    return new Deepseek({
      ...this._options,
      ...options,
      defaultHeaders: {
        ...(this._options.defaultHeaders ?? {}),
        ...(options.defaultHeaders ?? {}),
      },
      defaultQuery: {
        ...(this._options.defaultQuery ?? {}),
        ...(options.defaultQuery ?? {}),
      },
    });
  }

  // ─── Low-Level HTTP Client Methods (matching OpenAI SDK APIClient) ───────

  public get<Rsp = JsonValue>(path: string, options?: RequestOptions): APIPromise<Rsp> {
    return this.methodRequest<Rsp>(HttpMethod.GET, path, options);
  }

  public post<Rsp = JsonValue>(path: string, options?: RequestOptions): APIPromise<Rsp> {
    return this.methodRequest<Rsp>(HttpMethod.POST, path, options);
  }

  public put<Rsp = JsonValue>(path: string, options?: RequestOptions): APIPromise<Rsp> {
    return this.methodRequest<Rsp>(HttpMethod.PUT, path, options);
  }

  public patch<Rsp = JsonValue>(path: string, options?: RequestOptions): APIPromise<Rsp> {
    return this.methodRequest<Rsp>(HttpMethod.PATCH, path, options);
  }

  public delete<Rsp = JsonValue>(path: string, options?: RequestOptions): APIPromise<Rsp> {
    return this.methodRequest<Rsp>(HttpMethod.DELETE, path, options);
  }

  public request<Rsp = JsonValue>(
    options: RequestOptions & { method?: string; path: string },
  ): APIPromise<Rsp> {
    return this.methodRequest<Rsp>(options.method ?? HttpMethod.GET, options.path, options);
  }

  private methodRequest<Rsp = JsonValue>(
    method: string,
    path: string,
    options?: RequestOptions,
  ): APIPromise<Rsp> {
    let cachedPromise: Promise<{ data: Rsp; response: Response }> | null = null;
    const execute = async (): Promise<{ data: Rsp; response: Response }> => {
      if (cachedPromise) return cachedPromise;
      cachedPromise = (async () => {
        const cleanRelativePath =
          path.startsWith('http://') || path.startsWith('https://')
            ? new URL(path).pathname + new URL(path).search
            : `/${path.replace(/^\/+/, '')}`;
        const url = new URL(cleanRelativePath, 'https://ds2api.local');
        const query = { ...(this.defaultQuery ?? {}), ...(options?.query ?? {}) };
        for (const [k, v] of Object.entries(query)) {
          if (v !== undefined && v !== null) {
            url.searchParams.set(k, String(v));
          }
        }

        const headers: StringRecord = {
          ...(this.defaultHeaders ?? {}),
          ...(options?.headers ?? {}),
        };
        if (this.apiKey && !headers.Authorization && !headers.authorization) {
          headers[HttpHeader.AUTHORIZATION] = `${HttpHeader.BEARER_PREFIX}${this.apiKey}`;
        }

        let bodyInit: BodyInit | undefined;
        if (options?.body !== undefined && options?.body !== null) {
          if (
            typeof options.body === 'string' ||
            options.body instanceof ArrayBuffer ||
            (typeof FormData !== 'undefined' && options.body instanceof FormData) ||
            (typeof Blob !== 'undefined' && options.body instanceof Blob)
          ) {
            bodyInit = options.body;
          } else if (options.body instanceof Uint8Array) {
            bodyInit = options.body.slice().buffer as ArrayBuffer;
          } else {
            headers[HttpHeader.CONTENT_TYPE] = headers[HttpHeader.CONTENT_TYPE] ?? MimeType.JSON;
            bodyInit = JSON.stringify(options.body);
          }
        }

        const req = new Request(url.toString(), {
          method: method.toUpperCase(),
          headers,
          body: bodyInit,
          signal: options?.signal,
        });

        const response = await this.fetch(req);
        if (!response.ok) {
          const rawErrText = await response
            .clone()
            .text()
            .catch(() => `HTTP ${response.status}`);
          const errJson: JsonObject = safeJsonParseObject(rawErrText) ?? {};
          const errorBody = Object.keys(errJson).length > 0 ? errJson : { message: rawErrText };
          throw APIError.generate(
            response.status,
            errorBody,
            `HTTP ${response.status}`,
            headersToRecord(response.headers),
          );
        }

        const contentType = response.headers.get(HttpHeader.CONTENT_TYPE_LOWER) ?? '';
        const textBody = await response.clone().text();
        const data: Rsp = contentType.includes(MimeType.JSON)
          ? (JSON.parse(textBody) as Rsp)
          : (JSON.parse(JSON.stringify(textBody)) as Rsp);
        return { data, response };
      })();
      return cachedPromise;
    };

    return new APIPromise<Rsp>((resolve, reject) => {
      execute().then((r) => resolve(r.data), reject);
    }, execute);
  }

  // ─── Fetch Adapter & WinterCG Edge / Cloudflare Worker Handler ───────────

  /**
   * Returns a standard `fetch` function bound to this DS2API client.
   * Can be passed directly to the official `openai` npm package, Vercel AI SDK, or LangChain.
   */
  public asFetch(): typeof globalThis.fetch {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      return this.fetch(request);
    };
  }

  /**
   * WinterCG Edge HTTP handler (`(request: Request) => Promise<Response>`).
   * Directly usable in Cloudflare Workers (`export default { fetch: (req) => client.fetch(req) }`),
   * `Bun.serve({ fetch: (req) => client.fetch(req) })`, or Deno.serve.
   */
  public async fetch(request: Request): Promise<Response> {
    return this.router.dispatch(request);
  }

  // Static error aliases on the Deepseek class
  public static Deepseek = Deepseek;
  public static DeepSeek = Deepseek;
  public static OpenAI = Deepseek;
  public static OpenAIError = OpenAIError;
  public static APIError = APIError;
  public static BadRequestError = BadRequestError;
  public static AuthenticationError = AuthenticationError;
  public static NotFoundError = NotFoundError;
  public static toFile = toFile;
}

export { Deepseek as DeepSeek, Deepseek as OpenAI, Deepseek as DS2OpenAI };
export default Deepseek;
