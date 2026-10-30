/**
 * ChatCompletionStream helper matching OpenAI SDK's `chat.completions.stream()`
 * and `beta.chat.completions.stream()` / `runTools()`.
 *
 * Design Patterns Applied:
 * - Observer Pattern (`TypedStreamEventBus`) with strongly-typed per-event listener sets
 * - Declarative event dispatching via `ts-pattern`
 */

import { match, P } from 'ts-pattern';
import { Stream } from './core.js';
import {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessage,
  ChatFinishReason,
} from './types.js';
import { OpenAIToolCall } from '../toolcall/sieve.js';
import { buildUsage } from '../sse/parser.js';
import type { ChatCompletionStreamEventMap, StreamListenerBuckets } from '../@types/openai.js';

export type { ChatCompletionStreamEventMap, StreamListenerBuckets };

/**
 * Observer Pattern: Strongly-typed Event Bus for `ChatCompletionStream`
 * with zero `any` or `unknown`.
 */
class TypedStreamEventBus {
  private readonly buckets: StreamListenerBuckets = {
    connect: new Set(),
    chunk: new Set(),
    content: new Set(),
    reasoning_content: new Set(),
    message: new Set(),
    chatCompletion: new Set(),
    finalChatCompletion: new Set(),
    finalContent: new Set(),
    finalMessage: new Set(),
    error: new Set(),
    abort: new Set(),
    end: new Set(),
  };

  public add<K extends keyof ChatCompletionStreamEventMap>(
    event: K,
    listener: ChatCompletionStreamEventMap[K],
  ): void {
    this.buckets[event].add(listener);
  }

  public remove<K extends keyof ChatCompletionStreamEventMap>(
    event: K,
    listener: ChatCompletionStreamEventMap[K],
  ): void {
    this.buckets[event].delete(listener);
  }

  private invokeBucket<H>(bucket: Set<H>, invoke: (fn: H) => void): void {
    for (const fn of bucket) {
      try {
        invoke(fn);
      } catch {
        // Ignore user listener errors so stream consumption continues
      }
    }
  }

  public emitConnect(): void {
    this.invokeBucket(this.buckets.connect, (fn) => fn());
  }

  public emitChunk(chunk: ChatCompletionChunk, snapshot: ChatCompletion): void {
    this.invokeBucket(this.buckets.chunk, (fn) => fn(chunk, snapshot));
  }

  public emitContent(delta: string, snapshot: string): void {
    this.invokeBucket(this.buckets.content, (fn) => fn(delta, snapshot));
  }

  public emitReasoningContent(delta: string, snapshot: string): void {
    this.invokeBucket(this.buckets.reasoning_content, (fn) => fn(delta, snapshot));
  }

  public emitMessage(message: ChatCompletionMessage): void {
    this.invokeBucket(this.buckets.message, (fn) => fn(message));
  }

  public emitChatCompletion(completion: ChatCompletion): void {
    this.invokeBucket(this.buckets.chatCompletion, (fn) => fn(completion));
  }

  public emitFinalChatCompletion(completion: ChatCompletion): void {
    this.invokeBucket(this.buckets.finalChatCompletion, (fn) => fn(completion));
  }

  public emitFinalContent(contentSnapshot: string): void {
    this.invokeBucket(this.buckets.finalContent, (fn) => fn(contentSnapshot));
  }

  public emitFinalMessage(message: ChatCompletionMessage): void {
    this.invokeBucket(this.buckets.finalMessage, (fn) => fn(message));
  }

  public emitError(error: Error): void {
    this.invokeBucket(this.buckets.error, (fn) => fn(error));
  }

  public emitEnd(): void {
    this.invokeBucket(this.buckets.end, (fn) => fn());
  }
}

export class ChatCompletionStream implements AsyncIterable<ChatCompletionChunk> {
  public readonly controller: AbortController;
  private readonly innerStream: Stream<ChatCompletionChunk>;
  private readonly eventBus = new TypedStreamEventBus();
  private consumed = false;
  private finalCompletionPromise: Promise<ChatCompletion> | null = null;
  private currentSnapshot: ChatCompletion | null = null;
  private readonly promptText: string;

  constructor(innerStream: Stream<ChatCompletionChunk>, promptText: string = '') {
    this.innerStream = innerStream;
    this.controller = innerStream.controller;
    this.promptText = promptText;
  }

  public on<K extends keyof ChatCompletionStreamEventMap>(
    event: K,
    listener: ChatCompletionStreamEventMap[K],
  ): this {
    this.eventBus.add(event, listener);
    void this.ensurePumpStarted();
    return this;
  }

  public off<K extends keyof ChatCompletionStreamEventMap>(
    event: K,
    listener: ChatCompletionStreamEventMap[K],
  ): this {
    this.eventBus.remove(event, listener);
    return this;
  }

  public abort(): void {
    this.controller.abort();
  }

  public get currentChatCompletionSnapshot(): ChatCompletion | null {
    return this.currentSnapshot;
  }

  private ensurePumpStarted(): Promise<ChatCompletion> {
    if (!this.finalCompletionPromise) {
      this.finalCompletionPromise = this.consumeAll();
    }
    return this.finalCompletionPromise;
  }

  private async consumeAll(
    onChunk?: (chunk: ChatCompletionChunk) => void,
  ): Promise<ChatCompletion> {
    if (this.consumed && this.currentSnapshot) {
      return this.currentSnapshot;
    }
    this.consumed = true;
    this.eventBus.emitConnect();

    let id = `chatcmpl_${Date.now()}`;
    let created = Math.floor(Date.now() / 1000);
    let model = 'deepseek-v4-flash';
    let contentAcc = '';
    let reasoningAcc = '';
    let finishReason: ChatFinishReason = 'stop';
    const toolCallsMap = new Map<number, OpenAIToolCall>();

    const buildSnapshot = (): ChatCompletion => {
      const toolCalls = Array.from(toolCallsMap.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, tc]) => tc);

      const message: ChatCompletionMessage = {
        role: 'assistant',
        content: toolCalls.length > 0 && !contentAcc ? null : contentAcc,
      };
      if (reasoningAcc) {
        message.reasoning_content = reasoningAcc;
      }
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
      }

      const snap: ChatCompletion = {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message,
            logprobs: null,
            finish_reason: finishReason,
          },
        ],
        usage: buildUsage(this.promptText, reasoningAcc, contentAcc),
      };
      this.currentSnapshot = snap;
      return snap;
    };

    try {
      for await (const chunk of this.innerStream) {
        if (chunk.id) id = chunk.id;
        if (chunk.created) created = chunk.created;
        if (chunk.model) model = chunk.model;

        const choice = chunk.choices?.[0];
        if (choice) {
          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
          const delta = choice.delta;
          if (delta) {
            match(delta.reasoning_content)
              .with(P.string.minLength(1), (reasoningDelta) => {
                reasoningAcc += reasoningDelta;
                this.eventBus.emitReasoningContent(reasoningDelta, reasoningAcc);
              })
              .otherwise(() => {});

            match(delta.content)
              .with(P.string.minLength(1), (contentDelta) => {
                contentAcc += contentDelta;
                this.eventBus.emitContent(contentDelta, contentAcc);
              })
              .otherwise(() => {});

            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                const existing = toolCallsMap.get(idx);
                if (!existing) {
                  toolCallsMap.set(idx, {
                    id: tc.id || `call_${idx}`,
                    type: 'function',
                    function: {
                      name: tc.function?.name ?? '',
                      arguments: tc.function?.arguments ?? '',
                    },
                  });
                } else {
                  if (tc.function?.name) {
                    existing.function.name += tc.function.name;
                  }
                  if (tc.function?.arguments) {
                    existing.function.arguments += tc.function.arguments;
                  }
                }
              }
            }
          }
        }

        const snap = buildSnapshot();
        this.eventBus.emitChunk(chunk, snap);
        if (onChunk) onChunk(chunk);
      }

      const finalSnap = buildSnapshot();
      const finalMsg = finalSnap.choices[0].message;
      this.eventBus.emitMessage(finalMsg);
      this.eventBus.emitChatCompletion(finalSnap);
      this.eventBus.emitFinalMessage(finalMsg);
      if (typeof finalMsg.content === 'string') {
        this.eventBus.emitFinalContent(finalMsg.content);
      }
      this.eventBus.emitFinalChatCompletion(finalSnap);
      this.eventBus.emitEnd();
      return finalSnap;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.eventBus.emitError(error);
      this.eventBus.emitEnd();
      throw error;
    }
  }

  public async *[Symbol.asyncIterator](): AsyncIterator<ChatCompletionChunk> {
    if (this.consumed) {
      return;
    }
    const queue: ChatCompletionChunk[] = [];
    let done = false;
    let streamError: Error | null = null;
    let notify: (() => void) | null = null;

    this.finalCompletionPromise = this.consumeAll((chunk) => {
      queue.push(chunk);
      if (notify) {
        const fn = notify;
        notify = null;
        fn();
      }
    }).then(
      (res) => {
        done = true;
        if (notify) {
          const fn = notify;
          notify = null;
          fn();
        }
        return res;
      },
      (err) => {
        streamError = err instanceof Error ? err : new Error(String(err));
        done = true;
        if (notify) {
          const fn = notify;
          notify = null;
          fn();
        }
        throw streamError;
      },
    );

    while (true) {
      if (queue.length > 0) {
        const nextItem = queue.shift();
        if (nextItem) {
          yield nextItem;
        }
        continue;
      }
      if (streamError) {
        throw streamError;
      }
      if (done) {
        break;
      }
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  }

  public async finalChatCompletion(): Promise<ChatCompletion> {
    return this.ensurePumpStarted();
  }

  public async finalMessage(): Promise<ChatCompletionMessage> {
    const comp = await this.finalChatCompletion();
    return comp.choices[0].message;
  }

  public async finalContent(): Promise<string | null> {
    const msg = await this.finalMessage();
    return msg.content;
  }

  public async done(): Promise<void> {
    await this.finalChatCompletion();
  }

  public toReadableStream(): ReadableStream<Uint8Array> {
    return this.innerStream.toReadableStream();
  }
}
