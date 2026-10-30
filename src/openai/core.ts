/**
 * OpenAI SDK Core Primitives: Errors, OpenAIErrorFactory, APIPromise, Page, and Stream.
 * 100% Web-standard (Node.js, Bun, Cloudflare Workers).
 *
 * Design Patterns applied:
 * - Factory Pattern (`OpenAIErrorFactory` with `ts-pattern` exhaustive status matching)
 * - Decorator / Proxy Promise Pattern (`APIPromise<T>`)
 * - Iterator Pattern (`Page<Item>`, `Stream<Item>`)
 */

import { match, P } from 'ts-pattern';
import { isJsonObject, JsonObject, JsonValue, QueryRecord } from '../types/json.js';
import type { ErrorReason, RequestBodyPayload, RequestOptions } from '../@types/openai.js';

export type { ErrorReason, RequestBodyPayload, RequestOptions };

export class OpenAIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenAIError';
  }
}

export class APIError extends OpenAIError {
  public readonly status: number | undefined;
  public readonly headers: Record<string, string> | undefined;
  public readonly error: JsonObject | undefined;
  public readonly code: string | null | undefined;
  public readonly param: string | null | undefined;
  public readonly type: string | undefined;
  public readonly request_id: string | null | undefined;

  constructor(
    status: number | undefined,
    error: JsonObject | undefined,
    message: string | undefined,
    headers: Record<string, string> | undefined,
  ) {
    super(
      message ||
        (typeof error?.message === 'string' ? error.message : `API Error (${status ?? 'unknown'})`),
    );
    this.name = 'APIError';
    this.status = status;
    this.headers = headers;
    this.error = error;
    this.code = typeof error?.code === 'string' ? error.code : null;
    this.param = typeof error?.param === 'string' ? error.param : null;
    this.type = typeof error?.type === 'string' ? error.type : 'api_error';
    this.request_id = headers?.['x-request-id'] ?? null;
  }

  public static generate(
    status: number | undefined,
    errorResponse: JsonObject | undefined,
    message: string | undefined,
    headers: Record<string, string> | undefined,
  ): APIError {
    return OpenAIErrorFactory.create(status, errorResponse, message, headers);
  }
}

export class APIConnectionError extends APIError {
  public readonly cause?: Error;
  constructor({ message, cause }: { message?: string; cause?: Error }) {
    super(undefined, undefined, message || 'Connection error.', undefined);
    this.name = 'APIConnectionError';
    if (cause) this.cause = cause;
  }
}

export class APIConnectionTimeoutError extends APIConnectionError {
  constructor({ message }: { message?: string } = {}) {
    super({ message: message || 'Request timed out.' });
    this.name = 'APIConnectionTimeoutError';
  }
}

export class APIUserAbortError extends APIError {
  constructor({ message }: { message?: string } = {}) {
    super(undefined, undefined, message || 'Request was aborted.', undefined);
    this.name = 'APIUserAbortError';
  }
}

export class BadRequestError extends APIError {
  public override readonly status: 400 = 400;
  constructor(
    status: 400 = 400,
    error?: JsonObject,
    message?: string,
    headers?: Record<string, string>,
  ) {
    super(status, error, message, headers);
    this.name = 'BadRequestError';
  }
}

export class AuthenticationError extends APIError {
  public override readonly status: 401 = 401;
  constructor(
    status: 401 = 401,
    error?: JsonObject,
    message?: string,
    headers?: Record<string, string>,
  ) {
    super(status, error, message, headers);
    this.name = 'AuthenticationError';
  }
}

export class PermissionDeniedError extends APIError {
  public override readonly status: 403 = 403;
  constructor(
    status: 403 = 403,
    error?: JsonObject,
    message?: string,
    headers?: Record<string, string>,
  ) {
    super(status, error, message, headers);
    this.name = 'PermissionDeniedError';
  }
}

export class NotFoundError extends APIError {
  public override readonly status: 404 = 404;
  constructor(
    status: 404 = 404,
    error?: JsonObject,
    message?: string,
    headers?: Record<string, string>,
  ) {
    super(status, error, message, headers);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends APIError {
  public override readonly status: 409 = 409;
  constructor(
    status: 409 = 409,
    error?: JsonObject,
    message?: string,
    headers?: Record<string, string>,
  ) {
    super(status, error, message, headers);
    this.name = 'ConflictError';
  }
}

export class UnprocessableEntityError extends APIError {
  public override readonly status: 422 = 422;
  constructor(
    status: 422 = 422,
    error?: JsonObject,
    message?: string,
    headers?: Record<string, string>,
  ) {
    super(status, error, message, headers);
    this.name = 'UnprocessableEntityError';
  }
}

export class RateLimitError extends APIError {
  public override readonly status: 429 = 429;
  constructor(
    status: 429 = 429,
    error?: JsonObject,
    message?: string,
    headers?: Record<string, string>,
  ) {
    super(status, error, message, headers);
    this.name = 'RateLimitError';
  }
}

export class InternalServerError extends APIError {
  constructor(
    status: number = 500,
    error?: JsonObject,
    message?: string,
    headers?: Record<string, string>,
  ) {
    super(status, error, message, headers);
    this.name = 'InternalServerError';
  }
}

export class LengthFinishReasonError extends OpenAIError {
  constructor() {
    super('Could not parse response content as the length limit was reached');
    this.name = 'LengthFinishReasonError';
  }
}

export class ContentFilterFinishReasonError extends OpenAIError {
  constructor() {
    super('Could not parse response content as the request was rejected by the content filter');
    this.name = 'ContentFilterFinishReasonError';
  }
}

/**
 * Factory Pattern for instantiating typed OpenAI `APIError` subclasses by HTTP status code
 * using `ts-pattern`.
 */
export class OpenAIErrorFactory {
  public static create(
    status: number | undefined,
    errorResponse: JsonObject | undefined,
    message: string | undefined,
    headers: Record<string, string> | undefined,
  ): APIError {
    const errObj =
      errorResponse && isJsonObject(errorResponse.error) ? errorResponse.error : errorResponse;
    const msg =
      typeof errObj?.message === 'string'
        ? errObj.message
        : message || `HTTP ${status ?? 'unknown'}`;

    return match(status)
      .with(P.nullish, () => new APIConnectionError({ message: message || 'Connection error.' }))
      .with(400, () => new BadRequestError(400, errObj, msg, headers))
      .with(401, () => new AuthenticationError(401, errObj, msg, headers))
      .with(403, () => new PermissionDeniedError(403, errObj, msg, headers))
      .with(404, () => new NotFoundError(404, errObj, msg, headers))
      .with(409, () => new ConflictError(409, errObj, msg, headers))
      .with(422, () => new UnprocessableEntityError(422, errObj, msg, headers))
      .with(429, () => new RateLimitError(429, errObj, msg, headers))
      .with(
        P.when((s): s is number => typeof s === 'number' && s >= 500),
        (s) => new InternalServerError(s, errObj, msg, headers),
      )
      .otherwise((s) => new APIError(s, errObj, msg, headers));
  }
}

/**
 * Promise wrapper matching OpenAI SDK's APIPromise<T> with `.asResponse()` and `.withResponse()`.
 */
export class APIPromise<T> extends Promise<T> {
  private readonly responseFactory?: () => Promise<{ data: T; response: Response }>;

  constructor(
    executor: (
      resolve: (value: T | PromiseLike<T>) => void,
      reject: (reason?: ErrorReason) => void,
    ) => void,
    responseFactory?: () => Promise<{ data: T; response: Response }>,
  ) {
    super(executor);
    this.responseFactory = responseFactory;
  }

  public static from<T>(factory: () => Promise<T>, status: number = 200): APIPromise<T> {
    let cachedDataPromise: Promise<T> | null = null;
    const getData = (): Promise<T> => {
      if (!cachedDataPromise) {
        cachedDataPromise = factory();
      }
      return cachedDataPromise;
    };

    const getBoth = async (): Promise<{ data: T; response: Response }> => {
      const data = await getData();
      const isStream =
        typeof data === 'object' &&
        data !== null &&
        Symbol.asyncIterator in data &&
        'toReadableStream' in data;
      const response = isStream
        ? new Response(null, {
            status,
            headers: {
              'Content-Type': 'text/event-stream',
              'x-request-id': `req_${Date.now().toString(36)}`,
            },
          })
        : new Response(JSON.stringify(data), {
            status,
            headers: {
              'Content-Type': 'application/json',
              'x-request-id': `req_${Date.now().toString(36)}`,
            },
          });
      return { data, response };
    };

    return new APIPromise<T>((resolve, reject) => {
      getData().then(resolve, reject);
    }, getBoth);
  }

  public async asResponse(): Promise<Response> {
    if (this.responseFactory) {
      const { response } = await this.responseFactory();
      return response;
    }
    const data = await this;
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  public async withResponse(): Promise<{ data: T; response: Response; request_id: string | null }> {
    if (this.responseFactory) {
      const { data, response } = await this.responseFactory();
      return {
        data,
        response,
        request_id: response.headers.get('x-request-id'),
      };
    }
    const data = await this;
    const response = new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    return { data, response, request_id: null };
  }
}

/**
 * List page matching OpenAI SDK's Page<Item> with both `.data` and `for await (const item of page)`.
 */
export class Page<Item> implements AsyncIterable<Item> {
  public readonly object = 'list' as const;
  public readonly data: Item[];
  public readonly has_more: boolean;
  public readonly first_id?: string | null;
  public readonly last_id?: string | null;

  constructor(data: Item[], hasMore: boolean = false) {
    this.data = data;
    this.has_more = hasMore;
    const first = data[0];
    const last = data[data.length - 1];
    this.first_id =
      first && typeof first === 'object' && 'id' in first && typeof first.id === 'string'
        ? first.id
        : null;
    this.last_id =
      last && typeof last === 'object' && 'id' in last && typeof last.id === 'string'
        ? last.id
        : null;
  }

  public hasNextPage(): boolean {
    return this.has_more;
  }

  public async getNextPage(): Promise<Page<Item>> {
    return new Page<Item>([], false);
  }

  public async *[Symbol.asyncIterator](): AsyncIterator<Item> {
    for (const item of this.data) {
      yield item;
    }
  }
}

/**
 * Stream<Item> matching OpenAI SDK's Stream class.
 */
export class Stream<Item> implements AsyncIterable<Item> {
  public readonly controller: AbortController;
  private readonly iteratorFactory: () => AsyncIterator<Item>;

  constructor(iteratorFactory: () => AsyncIterator<Item>, controller?: AbortController) {
    this.iteratorFactory = iteratorFactory;
    this.controller = controller ?? new AbortController();
  }

  public [Symbol.asyncIterator](): AsyncIterator<Item> {
    return this.iteratorFactory();
  }

  public toReadableStream(): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const iter = this[Symbol.asyncIterator]();
    return new ReadableStream<Uint8Array>({
      pull: async (ctrl) => {
        try {
          const { value, done } = await iter.next();
          if (done) {
            ctrl.enqueue(encoder.encode('data: [DONE]\n\n'));
            ctrl.close();
            return;
          }
          ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
        } catch (err) {
          ctrl.error(err);
        }
      },
      cancel: () => {
        this.controller.abort();
      },
    });
  }

  public tee(): [Stream<Item>, Stream<Item>] {
    const leftQueue: Array<IteratorResult<Item>> = [];
    const rightQueue: Array<IteratorResult<Item>> = [];
    const iterator = this[Symbol.asyncIterator]();

    const makeIterator = (
      queue: Array<IteratorResult<Item>>,
      otherQueue: Array<IteratorResult<Item>>,
    ): AsyncIterator<Item> => {
      return {
        next: async () => {
          if (queue.length === 0) {
            const result = await iterator.next();
            queue.push(result);
            otherQueue.push(result);
          }
          return queue.shift()!;
        },
      };
    };

    return [
      new Stream(() => makeIterator(leftQueue, rightQueue), this.controller),
      new Stream(() => makeIterator(rightQueue, leftQueue), this.controller),
    ];
  }
}

/**
 * Create an `AbortController` linked to an optional upstream `AbortSignal`.
 */
export function createLinkedAbortController(signal?: AbortSignal | null): AbortController {
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
  }
  return controller;
}
