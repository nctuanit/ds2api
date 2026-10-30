/**
 * DeepSeek Web API Client using universal Web-standard fetch.
 * Compatible with Node.js, Bun, Cloudflare Workers, Deno, and Browsers.
 *
 * Design Patterns Applied:
 * - Gateway / Facade Pattern (`DeepSeekClient`)
 * - Builder Pattern (`DeepSeekHeaderBuilder`)
 * - Adapter Pattern (`ApiEnvelopeAdapter`)
 * - Template Method / Retry Executor Pattern (`AuthRetryExecutor`)
 * - Declarative pattern matching with `ts-pattern` (`match`, `P`)
 */

import { match, P } from 'ts-pattern';
import {
  BASE_HEADERS,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_COMPLETION_TARGET_PATH,
  DEEPSEEK_CONTINUE_TARGET_PATH,
  DEEPSEEK_UPLOAD_TARGET_PATH,
  DEFAULT_DEVICE_UUID,
  fetchServerModelConfigs,
  fetchServerModels,
  HttpHeader,
  HttpMethod,
  MimeType,
  ModelObject,
  ServerModelConfig,
} from '../protocol/constants.js';
import { solveAndBuildHeader } from '../pow/keccak.js';
import { AccountPool, DeepSeekAccount, RequestAuth } from '../auth/account-pool.js';
import { JsonCodec, JsonGuard, JsonObject } from '../types/json.js';
import type {
  DeepSeekClientOptions,
  ParsedApiResult,
  SessionInfo,
  UploadFileInput,
  UploadFileResult,
} from '../@types/deepseek.js';

export type {
  DeepSeekClientOptions,
  ParsedApiResult,
  SessionInfo,
  UploadFileInput,
  UploadFileResult,
};

const DEFAULT_DEVICE_ID = DEFAULT_DEVICE_UUID;
const DEFAULT_SHUMEI_ID = '20261029170534c26b4f0d359448645c6e82184408d59d003ddc0f114704b70';

const API_PATHS = Object.freeze({
  LOGIN: '/api/v0/users/login',
  CURRENT_USER: '/api/v0/users/current',
  CREATE_SESSION: '/api/v0/chat_session/create',
  FETCH_SESSION_PAGE: '/api/v0/chat_session/fetch_page',
  DELETE_SESSION: '/api/v0/chat_session/delete',
  DELETE_ALL_SESSIONS: '/api/v0/chat_session/delete_all',
  CREATE_POW: '/api/v0/chat/create_pow_challenge',
  COMPLETION: DEEPSEEK_COMPLETION_TARGET_PATH,
  CONTINUE: DEEPSEEK_CONTINUE_TARGET_PATH,
  UPLOAD_FILE: DEEPSEEK_UPLOAD_TARGET_PATH,
  FETCH_FILES: '/api/v0/file/fetch_files',
});

const TOKEN_INVALID_KEYWORDS: readonly string[] = Object.freeze([
  'token',
  'unauthorized',
  'expired',
  'not login',
  'login required',
  'invalid jwt',
  'session expired',
  '登录',
  '未登录',
  '认证',
  '凭证',
]);

// ─── Builder Pattern: DeepSeekHeaderBuilder ──────────────────────────────────

/**
 * Builder Pattern: Fluent builder for constructing DeepSeek Web API HTTP headers.
 */
export class DeepSeekHeaderBuilder {
  private readonly headers: Record<string, string>;

  public constructor(defaultHeaders?: Readonly<Record<string, string>>) {
    this.headers = {
      ...BASE_HEADERS,
      [HttpHeader.DEVICE_ID]: DEFAULT_DEVICE_ID,
      [HttpHeader.DEVICE_MODEL]: '',
      ...(defaultHeaders ?? {}),
    };
  }

  public withToken(token?: string): this {
    if (token && token.trim()) {
      this.headers[HttpHeader.AUTHORIZATION_LOWER] = `${HttpHeader.BEARER_PREFIX}${token.trim()}`;
    }
    return this;
  }

  public withPowResponse(powHeader?: string): this {
    if (powHeader) {
      this.headers[HttpHeader.POW_RESPONSE] = powHeader;
    }
    return this;
  }

  public withCustomHeaders(extra?: Readonly<Record<string, string>>): this {
    if (extra) {
      Object.assign(this.headers, extra);
    }
    return this;
  }

  public withoutContentType(): this {
    delete this.headers[HttpHeader.CONTENT_TYPE];
    return this;
  }

  public build(): Record<string, string> {
    return { ...this.headers };
  }
}

// ─── Adapter Pattern: ApiEnvelopeAdapter ─────────────────────────────────────

/**
 * Adapter Pattern: Normalizes DeepSeek HTTP JSON envelopes, binary file payloads,
 * and mobile login identifiers into strongly-typed domain structures.
 */
export class ApiEnvelopeAdapter {
  public static normalizeBaseURL(url?: string): string {
    const rawBase = (url || DEEPSEEK_BASE_URL).replace(/\/+$/, '');
    return rawBase.endsWith('/v1') ? rawBase.slice(0, -3) : rawBase;
  }

  public static normalizeMobileForLogin(raw: string): { mobile: string; areaCode: string } {
    const s = raw.trim();
    const hasPlus = s.startsWith('+');
    const digits = s.replace(/\D/g, '');
    if (!digits) {
      return { mobile: '', areaCode: '' };
    }
    if ((hasPlus || digits.startsWith('86')) && digits.startsWith('86') && digits.length === 13) {
      return { mobile: digits.slice(2), areaCode: '' };
    }
    return { mobile: digits, areaCode: '' };
  }

  public static parseEnvelope(status: number, raw: JsonObject): ParsedApiResult {
    const code = typeof raw.code === 'number' ? raw.code : 0;
    const msg = typeof raw.msg === 'string' ? raw.msg : '';
    const data = JsonGuard.isObject(raw.data) ? raw.data : {};
    const bizCode = typeof data.biz_code === 'number' ? data.biz_code : 0;
    const bizData = JsonGuard.isObject(data.biz_data) ? data.biz_data : {};
    let bizMsg = typeof data.biz_msg === 'string' ? data.biz_msg : '';
    if (!bizMsg && typeof bizData.msg === 'string') {
      bizMsg = bizData.msg;
    }
    return {
      status,
      code,
      bizCode,
      msg,
      bizMsg,
      bizData,
      raw,
      isOk: status === 200 && code === 0 && bizCode === 0,
    };
  }

  public static isTokenInvalid(res: ParsedApiResult): boolean {
    return match({ status: res.status, code: res.code, bizCode: res.bizCode })
      .with({ status: P.union(401, 403) }, () => true)
      .with({ code: P.union(40001, 40002, 40003) }, () => true)
      .with({ bizCode: P.union(40001, 40002, 40003) }, () => true)
      .otherwise(() => {
        const combined = `${res.msg} ${res.bizMsg}`.toLowerCase();
        return TOKEN_INVALID_KEYWORDS.some((kw) => combined.includes(kw));
      });
  }

  public static toBlobPayload(
    data: Uint8Array | ArrayBuffer | Blob | string,
    contentType: string,
  ): { blob: Blob; bytesLen: number } {
    if (typeof data === 'string') {
      const enc = new TextEncoder().encode(data);
      return {
        blob: new Blob([enc.buffer as ArrayBuffer], { type: contentType }),
        bytesLen: enc.byteLength,
      };
    }
    if (data instanceof Blob) {
      return { blob: data, bytesLen: data.size };
    }
    if (data instanceof Uint8Array) {
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      return {
        blob: new Blob([copy.buffer as ArrayBuffer], { type: contentType }),
        bytesLen: data.byteLength,
      };
    }
    return {
      blob: new Blob([data], { type: contentType }),
      bytesLen: data.byteLength,
    };
  }

  public static toUploadFileResult(
    fileObj: JsonObject,
    defaults: {
      id?: string;
      filename: string;
      bytes: number;
      status: string;
      purpose: string;
      accountId: string;
      raw: JsonObject;
    },
  ): UploadFileResult {
    const id = String(fileObj.id ?? fileObj.file_id ?? defaults.id ?? '');
    if (!id) {
      throw new Error('Upload file succeeded without file id.');
    }
    return {
      id,
      filename: String(fileObj.name ?? fileObj.filename ?? fileObj.file_name ?? defaults.filename),
      bytes: Number(fileObj.bytes ?? fileObj.size ?? fileObj.file_size ?? defaults.bytes),
      status: String(fileObj.status ?? fileObj.file_status ?? defaults.status),
      purpose: String(fileObj.purpose ?? defaults.purpose),
      isImage: Boolean(fileObj.is_image ?? fileObj.isImage ?? false),
      accountId: defaults.accountId,
      raw: defaults.raw,
    };
  }
}

// ─── Template Method / Retry Executor Pattern: AuthRetryExecutor ─────────────

/**
 * Template Method Pattern: Executes an authenticated DeepSeek API operation
 * with automatic token refresh and account rotation on `401`/`403`/`40001`–`40003`.
 */
export class AuthRetryExecutor {
  public constructor(private readonly pool: AccountPool) {}

  public async execute<T>(
    auth: RequestAuth,
    fallbackErrorMsg: string,
    signal: AbortSignal | null | undefined,
    maxAttempts: number,
    operation: () => Promise<{ res: ParsedApiResult; value?: T }>,
  ): Promise<T> {
    const triedIds = new Set<string>();
    let refreshed = false;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const { res, value } = await operation();
      if (res.isOk && value !== undefined) {
        return value;
      }

      if (auth.managed && ApiEnvelopeAdapter.isTokenInvalid(res)) {
        if (!refreshed && (await this.pool.refreshToken(auth, signal))) {
          refreshed = true;
          continue;
        }
        if (await this.pool.switchAccount(auth, signal, triedIds)) {
          refreshed = false;
          continue;
        }
      }
    }

    throw new Error(fallbackErrorMsg);
  }
}

// ─── Gateway / Facade Pattern: DeepSeekClient ────────────────────────────────

export class DeepSeekClient {
  private baseURL: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly maxRetries: number;
  private readonly defaultHeaders: Record<string, string>;
  private readonly retryExecutor: AuthRetryExecutor;
  public readonly pool: AccountPool;

  public constructor(options: DeepSeekClientOptions) {
    this.baseURL = ApiEnvelopeAdapter.normalizeBaseURL(options.baseURL);
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxRetries = options.maxRetries ?? 3;
    this.defaultHeaders = { ...(options.defaultHeaders ?? {}) };
    this.pool = options.pool;
    this.retryExecutor = new AuthRetryExecutor(this.pool);
    this.pool.setLoginFn((acc, sig) => this.login(acc, sig));
  }

  public setBaseURL(url: string): void {
    this.baseURL = ApiEnvelopeAdapter.normalizeBaseURL(url);
  }

  private buildHeaders(
    token?: string,
    extra?: Record<string, string>,
    omitContentType = false,
  ): Record<string, string> {
    const builder = new DeepSeekHeaderBuilder(this.defaultHeaders)
      .withCustomHeaders(extra)
      .withToken(token);
    if (omitContentType) {
      builder.withoutContentType();
    }
    return builder.build();
  }

  private async requestJSON(
    method: 'GET' | 'POST',
    path: string,
    options: {
      token?: string;
      headers?: Record<string, string>;
      body?: JsonObject | FormData;
      signal?: AbortSignal | null;
    } = {},
  ): Promise<ParsedApiResult> {
    const isForm = options.body instanceof FormData;
    const headers = this.buildHeaders(options.token, options.headers, isForm);
    let requestBody: BodyInit | undefined;

    if (options.body instanceof FormData) {
      requestBody = options.body;
    } else if (options.body !== undefined) {
      requestBody = JSON.stringify(options.body);
    }

    const res = await this.fetchImpl(`${this.baseURL}${path}`, {
      method,
      headers,
      body: requestBody,
      signal: options.signal ?? undefined,
    });
    const text = await res.text();
    const raw = JsonCodec.parseObject(text) ?? { raw: text };
    return ApiEnvelopeAdapter.parseEnvelope(res.status, raw);
  }

  public async login(account: DeepSeekAccount, signal?: AbortSignal | null): Promise<string> {
    const payload: JsonObject = {
      email: '',
      mobile: '',
      area_code: '',
      password: (account.password ?? '').trim(),
      device_id: DEFAULT_SHUMEI_ID,
      os: 'android',
    };

    if (account.email?.trim()) {
      payload.email = account.email.trim();
    } else if (account.mobile?.trim()) {
      const { mobile, areaCode } = ApiEnvelopeAdapter.normalizeMobileForLogin(account.mobile);
      payload.mobile = mobile;
      payload.area_code = areaCode;
    } else {
      throw new Error('DeepSeek login requires email or mobile along with password.');
    }

    const res = await this.requestJSON(HttpMethod.POST, API_PATHS.LOGIN, { body: payload, signal });
    if (!res.isOk) {
      throw new Error(`DeepSeek login failed: ${res.bizMsg || res.msg || `HTTP ${res.status}`}`);
    }

    const user = JsonGuard.isObject(res.bizData.user) ? res.bizData.user : {};
    const token = typeof user.token === 'string' ? user.token.trim() : '';
    if (!token) {
      throw new Error('DeepSeek login response missing user token.');
    }
    return token;
  }

  public async getCurrentUser(
    auth: RequestAuth,
    signal?: AbortSignal | null,
    maxAttempts: number = this.maxRetries,
  ): Promise<JsonObject> {
    return this.retryExecutor.execute(
      auth,
      'Failed to fetch DeepSeek current user.',
      signal,
      maxAttempts,
      async () => {
        const res = await this.requestJSON(HttpMethod.GET, API_PATHS.CURRENT_USER, {
          token: auth.token,
          signal,
        });
        return {
          res,
          value: res.isOk ? res.bizData : undefined,
        };
      },
    );
  }

  /**
   * Fetches raw server model configurations from `/api/v0/client/settings?did=<deviceId>&scope=model`.
   */
  public async getModelConfigs(
    auth?: RequestAuth,
    signal?: AbortSignal | null,
  ): Promise<ServerModelConfig[]> {
    return fetchServerModelConfigs({
      baseURL: this.baseURL,
      token: auth?.token,
      deviceId: DEFAULT_DEVICE_ID,
      fetch: this.fetchImpl,
      signal,
    });
  }

  /**
   * Fetches OpenAI-compatible `ModelObject[]` dynamically synced from the DeepSeek server.
   */
  public async getModels(auth?: RequestAuth, signal?: AbortSignal | null): Promise<ModelObject[]> {
    return fetchServerModels({
      baseURL: this.baseURL,
      token: auth?.token,
      deviceId: DEFAULT_DEVICE_ID,
      fetch: this.fetchImpl,
      signal,
    });
  }

  public async createSession(
    auth: RequestAuth,
    signal?: AbortSignal | null,
    maxAttempts: number = this.maxRetries,
  ): Promise<string> {
    return this.retryExecutor.execute(
      auth,
      'Failed to create DeepSeek chat session.',
      signal,
      maxAttempts,
      async () => {
        const res = await this.requestJSON(HttpMethod.POST, API_PATHS.CREATE_SESSION, {
          token: auth.token,
          body: { agent: 'chat' },
          signal,
        });
        if (!res.isOk) {
          return { res };
        }
        const directId = typeof res.bizData.id === 'string' ? res.bizData.id.trim() : '';
        const nestedSession = JsonGuard.isObject(res.bizData.chat_session)
          ? res.bizData.chat_session
          : {};
        const nestedId = typeof nestedSession.id === 'string' ? nestedSession.id.trim() : '';
        const sessionId = directId || nestedId;
        return {
          res,
          value: sessionId || undefined,
        };
      },
    );
  }

  public async getPow(
    auth: RequestAuth,
    targetPath: string = DEEPSEEK_COMPLETION_TARGET_PATH,
    signal?: AbortSignal | null,
    maxAttempts: number = this.maxRetries,
  ): Promise<string> {
    return this.retryExecutor.execute(
      auth,
      'Failed to obtain or solve DeepSeek PoW challenge.',
      signal,
      maxAttempts,
      async () => {
        const res = await this.requestJSON(HttpMethod.POST, API_PATHS.CREATE_POW, {
          token: auth.token,
          body: { target_path: targetPath || DEEPSEEK_COMPLETION_TARGET_PATH },
          signal,
        });
        if (!res.isOk) {
          return { res };
        }
        const challenge = JsonGuard.isObject(res.bizData.challenge) ? res.bizData.challenge : {};
        return {
          res,
          value: solveAndBuildHeader(challenge, signal),
        };
      },
    );
  }

  public async callCompletion(
    auth: RequestAuth,
    payload: JsonObject,
    powHeader: string,
    signal?: AbortSignal | null,
  ): Promise<Response> {
    return this.fetchImpl(`${this.baseURL}${API_PATHS.COMPLETION}`, {
      method: HttpMethod.POST,
      headers: this.buildHeaders(auth.token, { [HttpHeader.POW_RESPONSE]: powHeader }),
      body: JSON.stringify(payload),
      signal: signal ?? undefined,
    });
  }

  public async callContinue(
    auth: RequestAuth,
    sessionId: string,
    messageId: string | number,
    powHeader: string,
    signal?: AbortSignal | null,
  ): Promise<Response> {
    return this.fetchImpl(`${this.baseURL}${API_PATHS.CONTINUE}`, {
      method: HttpMethod.POST,
      headers: this.buildHeaders(auth.token, { [HttpHeader.POW_RESPONSE]: powHeader }),
      body: JSON.stringify({
        chat_session_id: sessionId,
        message_id: messageId,
      }),
      signal: signal ?? undefined,
    });
  }

  public async uploadFile(
    auth: RequestAuth,
    req: UploadFileInput,
    signal?: AbortSignal | null,
  ): Promise<UploadFileResult> {
    const powHeader = await this.getPow(auth, DEEPSEEK_UPLOAD_TARGET_PATH, signal);
    const filename = (req.filename || 'upload.bin').trim();
    const contentType = req.contentType || MimeType.OCTET_STREAM;
    const { blob, bytesLen } = ApiEnvelopeAdapter.toBlobPayload(req.data, contentType);

    const form = new FormData();
    form.append('file', blob, filename);

    const res = await this.requestJSON(HttpMethod.POST, API_PATHS.UPLOAD_FILE, {
      token: auth.token,
      headers: {
        [HttpHeader.POW_RESPONSE]: powHeader,
        [HttpHeader.THINKING_ENABLED]: '1',
      },
      body: form,
      signal,
    });

    if (!res.isOk) {
      throw new Error(`Upload file failed: ${res.bizMsg || res.msg || `HTTP ${res.status}`}`);
    }

    const fileObj = JsonGuard.isObject(res.bizData.file) ? res.bizData.file : res.bizData;
    return ApiEnvelopeAdapter.toUploadFileResult(fileObj, {
      filename,
      bytes: bytesLen,
      status: 'uploaded',
      purpose: req.purpose || 'assistants',
      accountId: auth.accountId,
      raw: res.raw,
    });
  }

  public async fetchUploadedFile(
    auth: RequestAuth,
    fileId: string,
    signal?: AbortSignal | null,
  ): Promise<UploadFileResult> {
    const res = await this.requestJSON(
      HttpMethod.GET,
      `${API_PATHS.FETCH_FILES}?file_ids=${encodeURIComponent(fileId)}`,
      { token: auth.token, signal },
    );

    if (!res.isOk) {
      throw new Error(`Fetch file failed: ${res.bizMsg || res.msg || `HTTP ${res.status}`}`);
    }

    const files = JsonGuard.isArray(res.bizData.files) ? res.bizData.files : [];
    const foundObj =
      files.find(
        (f): f is JsonObject => JsonGuard.isObject(f) && (f.id === fileId || f.file_id === fileId),
      ) ?? (JsonGuard.isObject(files[0]) ? files[0] : undefined);

    if (!foundObj) {
      throw new Error(`File '${fileId}' not found.`);
    }

    return ApiEnvelopeAdapter.toUploadFileResult(foundObj, {
      id: fileId,
      filename: '',
      bytes: 0,
      status: 'processed',
      purpose: 'assistants',
      accountId: auth.accountId,
      raw: res.raw,
    });
  }

  public async fetchSessionPage(
    auth: RequestAuth,
    cursor?: string,
    signal?: AbortSignal | null,
  ): Promise<{ sessions: SessionInfo[]; hasMore: boolean }> {
    const params = new URLSearchParams({ 'lte_cursor.pinned': 'false' });
    if (cursor) {
      params.set('lte_cursor', cursor);
    }

    const res = await this.requestJSON(
      HttpMethod.GET,
      `${API_PATHS.FETCH_SESSION_PAGE}?${params.toString()}`,
      { token: auth.token, signal },
    );

    if (res.status !== 200 || res.code !== 0) {
      throw new Error(`Fetch sessions failed: ${res.msg || `HTTP ${res.status}`}`);
    }

    const rawSessions = JsonGuard.isArray(res.bizData.chat_sessions)
      ? res.bizData.chat_sessions
      : [];
    const sessions: SessionInfo[] = rawSessions
      .filter((s): s is JsonObject => JsonGuard.isObject(s))
      .map((s) => ({
        id: String(s.id ?? ''),
        title: String(s.title ?? ''),
        titleType: String(s.title_type ?? ''),
        pinned: Boolean(s.pinned),
        updatedAt: Number(s.updated_at ?? 0),
      }));

    return {
      sessions,
      hasMore: Boolean(res.bizData.has_more),
    };
  }

  public async deleteSession(
    auth: RequestAuth,
    sessionId: string,
    signal?: AbortSignal | null,
  ): Promise<boolean> {
    const res = await this.requestJSON(HttpMethod.POST, API_PATHS.DELETE_SESSION, {
      token: auth.token,
      body: { chat_session_id: sessionId },
      signal,
    });
    return res.isOk;
  }

  public async deleteAllSessions(auth: RequestAuth, signal?: AbortSignal | null): Promise<boolean> {
    const res = await this.requestJSON(HttpMethod.POST, API_PATHS.DELETE_ALL_SESSIONS, {
      token: auth.token,
      body: {},
      signal,
    });
    return res.isOk;
  }
}
