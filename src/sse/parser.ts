/**
 * DeepSeek SSE chunk parser, thinking/text splitter, continuation overlap deduper,
 * and token usage estimator.
 *
 * Design Patterns Applied:
 * - Filter / Sanitizer Pattern (`TextSanitizer`)
 * - Visitor / Tree Interpreter Pattern (`SSEChunkParser`)
 * - Strategy / Calculator Pattern (`TokenUsageCalculator`)
 * - Async Iterator Pattern (`SSEStreamReader`)
 * - Declarative pattern matching with `ts-pattern` (`match`, `P`)
 */

import { match, P } from 'ts-pattern';
import {
  FragmentTypeConst,
  SKIP_CONTAINS_PATTERNS,
  SKIP_EXACT_PATHS,
  SSEConst,
  SSEPath,
} from '../protocol/constants.js';
import { JsonArray, JsonCodec, JsonGuard, JsonObject, JsonValue } from '../types/json.js';
import type { ChatUsage, FragmentCategory, ParsedChunkResult, ParsedPart } from '../@types/sse.js';

export type { ChatUsage, FragmentCategory, ParsedChunkResult, ParsedPart };

const LEAKED_BOS_MARKER_PATTERN = /<[|\uFF5C]\s*begin[_▁]of[_▁]sentence\s*[|\uFF5C]>/gi;
const LEAKED_THOUGHT_MARKER_PATTERN =
  /<[|\uFF5C]\s*(?:begin[_▁])?[_▁]*of[_▁]thought\s*[|\uFF5C]>/gi;
const LEAKED_META_MARKER_PATTERN =
  /<[|\uFF5C]\s*(?:assistant|tool|end[_▁]of[_▁]sentence|end[_▁]of[_▁]thinking|end[_▁]of[_▁]thought|end[_▁]of[_▁]toolresults|end[_▁]of[_▁]instructions)\s*[|\uFF5C]>/gi;
const MIN_CONTINUATION_SNAPSHOT_LEN = 32;
const MAX_RECURSION_DEPTH = 16;
const MAX_SSE_BUFFER_LENGTH = 4 * 1024 * 1024;

// ─── Filter / Sanitizer Pattern: TextSanitizer ───────────────────────────────

/**
 * Filter / Sanitizer Pattern: Strips leaked `<think>` tags, reference markers,
 * special BOS/meta tokens, and `CONTENT_FILTER` trailing suffixes.
 */
export class TextSanitizer {
  public static stripThinkTags(text: string): string {
    if (!text) return text;
    return text.replace(/<\/?\s*think\s*>/gi, '');
  }

  public static stripReferenceMarkers(text: string): string {
    if (!text) return text;
    return text
      .replace(/\[(?:citation|reference):\s*\d+\]/gi, '')
      .replace(LEAKED_BOS_MARKER_PATTERN, '')
      .replace(LEAKED_THOUGHT_MARKER_PATTERN, '')
      .replace(LEAKED_META_MARKER_PATTERN, '');
  }

  public static stripLeakedContentFilterSuffix(text: string): { text: string; stripped: boolean } {
    if (typeof text !== 'string' || text === '') {
      return { text, stripped: false };
    }
    const idx = text.toUpperCase().indexOf(SSEConst.CONTENT_FILTER_UPPER);
    if (idx < 0) {
      return { text, stripped: false };
    }
    return {
      text: text.slice(0, idx).replace(/[ \t\r]+$/g, ''),
      stripped: true,
    };
  }

  public static shouldDropCleanedLeakedChunk(cleaned: string): boolean {
    if (cleaned === '') return true;
    if (cleaned.includes('\n')) return false;
    return cleaned.trim() === '';
  }

  public static filterLeakedContentFilterParts(parts: ParsedPart[]): ParsedPart[] {
    if (!Array.isArray(parts) || parts.length === 0) return parts;
    const out: ParsedPart[] = [];
    for (const p of parts) {
      if (!p || typeof p !== 'object') continue;
      const { text, stripped } = TextSanitizer.stripLeakedContentFilterSuffix(p.text);
      if (stripped && TextSanitizer.shouldDropCleanedLeakedChunk(text)) continue;
      if (stripped) {
        out.push({ ...p, text });
        continue;
      }
      out.push(p);
    }
    return out;
  }
}

// ─── Visitor / Tree Interpreter Pattern: SSEChunkParser ──────────────────────

/**
 * Visitor / Tree Interpreter Pattern: Traverses DeepSeek SSE JSON patch chunks,
 * classifies fragment types, and splits `<think>...</think>` blocks.
 */
export class SSEChunkParser {
  public static classifyFragmentType(
    rawType: string,
    fallback: FragmentCategory,
  ): FragmentCategory {
    return match(rawType.toUpperCase())
      .with(
        P.union(FragmentTypeConst.RAW_THINK, FragmentTypeConst.RAW_THINKING),
        () => FragmentTypeConst.THINKING,
      )
      .with(FragmentTypeConst.RAW_RESPONSE, () => FragmentTypeConst.TEXT)
      .otherwise(() => fallback);
  }

  public static resolveItemPathCategory(
    itemPath: string,
    defaultType: FragmentCategory,
  ): FragmentCategory {
    if (itemPath.includes(FragmentTypeConst.THINKING)) {
      return FragmentTypeConst.THINKING;
    }
    if (
      itemPath.includes('content') ||
      itemPath === SSEPath.RESPONSE ||
      itemPath === SSEPath.FRAGMENTS
    ) {
      return FragmentTypeConst.TEXT;
    }
    return defaultType;
  }

  public static isStatusPath(pathValue: string): boolean {
    return pathValue === SSEPath.RESPONSE_STATUS || pathValue === SSEPath.STATUS;
  }

  public static isFinishedStatus(value: JsonValue | undefined): boolean {
    return JsonCodec.asCleanString(value).toUpperCase() === SSEConst.STATUS_FINISHED;
  }

  public static isFragmentStatusPath(pathValue: string): boolean {
    if (!pathValue || pathValue === SSEPath.RESPONSE_STATUS) return false;
    return /^response\/fragments\/-?\d+\/status$/i.test(pathValue);
  }

  public static shouldSkipPath(pathValue: string): boolean {
    if (SSEChunkParser.isFragmentStatusPath(pathValue)) return true;
    if (SKIP_EXACT_PATHS.has(pathValue)) return true;
    for (const p of SKIP_CONTAINS_PATTERNS) {
      if (pathValue.includes(p)) return true;
    }
    return false;
  }

  public static hasContentFilterStatus(chunk: JsonValue | undefined): boolean {
    if (!JsonGuard.isObject(chunk)) return false;
    const code = JsonCodec.asCleanString(chunk.code);
    if (code && code.toLowerCase() === SSEConst.CONTENT_FILTER) return true;
    return SSEChunkParser.hasContentFilterStatusValue(chunk);
  }

  private static hasContentFilterStatusValue(v: JsonValue | undefined, depth: number = 0): boolean {
    if (depth > MAX_RECURSION_DEPTH) return false;
    if (JsonGuard.isArray(v)) {
      return v.some((item) => SSEChunkParser.hasContentFilterStatusValue(item, depth + 1));
    }
    if (!JsonGuard.isObject(v)) return false;
    const pathValue = JsonCodec.asCleanString(v.p);
    if (pathValue && pathValue.toLowerCase().includes(SSEPath.STATUS)) {
      if (JsonCodec.asCleanString(v.v).toLowerCase() === SSEConst.CONTENT_FILTER) return true;
    }
    if (JsonCodec.asCleanString(v.code).toLowerCase() === SSEConst.CONTENT_FILTER) return true;
    return Object.values(v).some((val) =>
      SSEChunkParser.hasContentFilterStatusValue(val, depth + 1),
    );
  }

  public static asContentString(
    v: JsonValue | undefined,
    stripRefMarkers: boolean = true,
    depth: number = 0,
  ): string {
    if (depth > MAX_RECURSION_DEPTH) return '';
    if (typeof v === 'string') {
      return stripRefMarkers ? TextSanitizer.stripReferenceMarkers(v) : v;
    }
    if (JsonGuard.isArray(v)) {
      return v
        .map((item) => SSEChunkParser.asContentString(item, stripRefMarkers, depth + 1))
        .join('');
    }
    if (JsonGuard.isObject(v)) {
      if ('content' in v && v.content !== undefined) {
        return SSEChunkParser.asContentString(v.content, stripRefMarkers, depth + 1);
      }
      if ('v' in v && v.v !== undefined) {
        return SSEChunkParser.asContentString(v.v, stripRefMarkers, depth + 1);
      }
      if ('text' in v && v.text !== undefined) {
        return SSEChunkParser.asContentString(v.text, stripRefMarkers, depth + 1);
      }
      if ('value' in v && v.value !== undefined) {
        return SSEChunkParser.asContentString(v.value, stripRefMarkers, depth + 1);
      }
      return '';
    }
    if (v === null || v === undefined) return '';
    const text = String(v);
    return stripRefMarkers ? TextSanitizer.stripReferenceMarkers(text) : text;
  }

  private static splitThinkingParts(parts: ParsedPart[]): {
    parts: ParsedPart[];
    transitioned: boolean;
  } {
    const out: ParsedPart[] = [];
    let thinkingDone = false;
    for (const p of parts) {
      if (!p) continue;
      if (thinkingDone && p.type === FragmentTypeConst.THINKING) {
        const cleaned = TextSanitizer.stripThinkTags(p.text);
        if (cleaned) {
          out.push({ text: cleaned, type: FragmentTypeConst.TEXT });
        }
        continue;
      }
      if (p.type !== FragmentTypeConst.THINKING) {
        const cleaned = TextSanitizer.stripThinkTags(p.text);
        if (cleaned) {
          out.push({ text: cleaned, type: p.type });
        }
        continue;
      }
      const closeMatch = /<\/\s*think\s*>/i.exec(p.text);
      if (!closeMatch) {
        out.push(p);
        continue;
      }
      thinkingDone = true;
      const before = p.text.substring(0, closeMatch.index);
      let after = p.text.substring(closeMatch.index + closeMatch[0].length);
      if (before) {
        out.push({ text: before, type: FragmentTypeConst.THINKING });
      }
      after = TextSanitizer.stripThinkTags(after);
      if (after) {
        out.push({ text: after, type: FragmentTypeConst.TEXT });
      }
    }
    return { parts: out, transitioned: thinkingDone };
  }

  private static finalizeChunkParts(
    parts: ParsedPart[],
    thinkingEnabled: boolean,
    newType: FragmentCategory,
    responseMessageId?: string,
  ): ParsedChunkResult {
    const resolvedParts = TextSanitizer.filterLeakedContentFilterParts(parts);
    const splitResult = SSEChunkParser.splitThinkingParts(resolvedParts);
    const finalType: FragmentCategory = splitResult.transitioned ? FragmentTypeConst.TEXT : newType;
    const finalParts = thinkingEnabled
      ? splitResult.parts
      : splitResult.parts.filter((p) => p && p.type !== FragmentTypeConst.THINKING);
    return SSEChunkParser.makeChunkResult(finalType, responseMessageId, {
      parts: finalParts,
    });
  }

  private static extractResponseMessageId(chunk: JsonObject): string | undefined {
    if (typeof chunk.response_message_id === 'string' && chunk.response_message_id) {
      return chunk.response_message_id;
    }
    if (JsonGuard.isObject(chunk.v) && JsonGuard.isObject(chunk.v.response)) {
      const msgId = chunk.v.response.message_id;
      if (typeof msgId === 'number' || typeof msgId === 'string') {
        return String(msgId);
      }
    }
    return undefined;
  }

  private static formatErrorMessage(v: JsonValue | undefined): string {
    if (typeof v === 'string') return v;
    if (v === null || v === undefined) return String(v);
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }

  private static makeChunkResult(
    newType: FragmentCategory,
    responseMessageId?: string,
    overrides?: Partial<ParsedChunkResult>,
  ): ParsedChunkResult {
    return {
      parsed: true,
      parts: [],
      finished: false,
      contentFilter: false,
      errorMessage: '',
      promptTokens: 0,
      outputTokens: 0,
      newType,
      ...(responseMessageId !== undefined ? { responseMessageId } : {}),
      ...overrides,
    };
  }

  public static extractContentRecursive(
    items: JsonArray,
    defaultType: FragmentCategory,
    stripRefMarkers: boolean = true,
  ): { parts: ParsedPart[]; finished: boolean } {
    const parts: ParsedPart[] = [];
    for (const rawItem of items) {
      if (!JsonGuard.isObject(rawItem)) continue;
      if (!Object.prototype.hasOwnProperty.call(rawItem, 'v') || rawItem.v === undefined) continue;
      const itemPath = JsonCodec.asCleanString(rawItem.p);
      const itemV = rawItem.v;
      if (SSEChunkParser.isStatusPath(itemPath)) {
        if (SSEChunkParser.isFinishedStatus(itemV)) {
          return { parts: [], finished: true };
        }
        continue;
      }
      if (SSEChunkParser.shouldSkipPath(itemPath)) continue;

      const content = SSEChunkParser.asContentString(rawItem.content, stripRefMarkers);
      if (content) {
        const fragType = SSEChunkParser.classifyFragmentType(
          JsonCodec.asCleanString(rawItem.type),
          defaultType,
        );
        parts.push({ text: content, type: fragType });
        continue;
      }

      const partType = SSEChunkParser.resolveItemPathCategory(itemPath, defaultType);

      if (typeof itemV === 'string') {
        if (SSEChunkParser.isStatusPath(itemPath)) continue;
        if (itemV && itemV !== SSEConst.STATUS_FINISHED) {
          const c = SSEChunkParser.asContentString(itemV, stripRefMarkers);
          if (c) parts.push({ text: c, type: partType });
        }
        continue;
      }

      if (!JsonGuard.isArray(itemV)) continue;
      for (const inner of itemV) {
        if (typeof inner === 'string') {
          if (inner) {
            const c = SSEChunkParser.asContentString(inner, stripRefMarkers);
            if (c) parts.push({ text: c, type: partType });
          }
          continue;
        }
        if (!JsonGuard.isObject(inner)) continue;
        const ct = SSEChunkParser.asContentString(inner.content, stripRefMarkers);
        if (!ct) continue;
        const fragType = SSEChunkParser.classifyFragmentType(
          JsonCodec.asCleanString(inner.type),
          partType,
        );
        parts.push({ text: ct, type: fragType });
      }
    }
    return { parts, finished: false };
  }

  public static parseChunk(
    chunk: JsonObject | null | undefined,
    thinkingEnabled: boolean,
    currentType: FragmentCategory,
    stripRefMarkers: boolean = true,
  ): ParsedChunkResult {
    if (!chunk || typeof chunk !== 'object') {
      return SSEChunkParser.makeChunkResult(currentType, undefined, { parsed: false });
    }

    const responseMessageId = SSEChunkParser.extractResponseMessageId(chunk);

    if (Object.prototype.hasOwnProperty.call(chunk, 'error') && chunk.error !== undefined) {
      return SSEChunkParser.makeChunkResult(currentType, responseMessageId, {
        finished: true,
        errorMessage: SSEChunkParser.formatErrorMessage(chunk.error),
      });
    }

    const pathValue = JsonCodec.asCleanString(chunk.p);

    if (SSEChunkParser.hasContentFilterStatus(chunk)) {
      return SSEChunkParser.makeChunkResult(currentType, responseMessageId, {
        finished: true,
        contentFilter: true,
      });
    }

    if (SSEChunkParser.shouldSkipPath(pathValue)) {
      return SSEChunkParser.makeChunkResult(currentType, responseMessageId);
    }

    if (SSEChunkParser.isStatusPath(pathValue)) {
      return SSEChunkParser.makeChunkResult(currentType, responseMessageId, {
        finished: SSEChunkParser.isFinishedStatus(chunk.v),
      });
    }

    if (!Object.prototype.hasOwnProperty.call(chunk, 'v') || chunk.v === undefined) {
      return SSEChunkParser.makeChunkResult(currentType, responseMessageId);
    }

    let newType: FragmentCategory = currentType;
    const parts: ParsedPart[] = [];

    if (
      pathValue === SSEPath.RESPONSE_FRAGMENTS &&
      JsonCodec.asCleanString(chunk.o).toUpperCase() === SSEConst.OP_APPEND &&
      JsonGuard.isArray(chunk.v)
    ) {
      for (const frag of chunk.v) {
        if (!JsonGuard.isObject(frag)) continue;
        const fragType = SSEChunkParser.classifyFragmentType(
          JsonCodec.asCleanString(frag.type),
          FragmentTypeConst.TEXT,
        );
        const content = SSEChunkParser.asContentString(frag.content, stripRefMarkers);
        if (!content) continue;
        newType = fragType;
        parts.push({ text: content, type: fragType });
      }
    }

    if (pathValue === SSEPath.RESPONSE && JsonGuard.isArray(chunk.v)) {
      for (const item of chunk.v) {
        if (!JsonGuard.isObject(item)) continue;
        if (
          item.p === SSEPath.FRAGMENTS &&
          item.o === SSEConst.OP_APPEND &&
          JsonGuard.isArray(item.v)
        ) {
          for (const frag of item.v) {
            if (!JsonGuard.isObject(frag)) continue;
            newType = SSEChunkParser.classifyFragmentType(
              JsonCodec.asCleanString(frag.type),
              newType,
            );
          }
        }
      }
    }

    if (pathValue === SSEPath.RESPONSE_CONTENT) {
      newType = FragmentTypeConst.TEXT;
    } else if (
      pathValue === SSEPath.RESPONSE_THINKING_CONTENT &&
      (!thinkingEnabled || newType !== FragmentTypeConst.TEXT)
    ) {
      newType = FragmentTypeConst.THINKING;
    }

    const partType: FragmentCategory = match(pathValue)
      .with(SSEPath.RESPONSE_THINKING_CONTENT, () =>
        !thinkingEnabled || newType !== FragmentTypeConst.TEXT
          ? FragmentTypeConst.THINKING
          : FragmentTypeConst.TEXT,
      )
      .with(SSEPath.RESPONSE_CONTENT, () => FragmentTypeConst.TEXT)
      .with(
        P.when((p) => p.includes(SSEPath.RESPONSE_FRAGMENTS) && p.includes('/content')),
        () => newType,
      )
      .with('', () => newType)
      .otherwise(() => FragmentTypeConst.TEXT);

    const val = chunk.v;

    if (typeof val === 'string') {
      if (SSEChunkParser.isFinishedStatus(val) && (!pathValue || pathValue === SSEPath.STATUS)) {
        return SSEChunkParser.makeChunkResult(newType, responseMessageId, { finished: true });
      }
      if (SSEChunkParser.isStatusPath(pathValue)) {
        return SSEChunkParser.makeChunkResult(newType, responseMessageId);
      }
      const content = SSEChunkParser.asContentString(val, stripRefMarkers);
      if (content) {
        parts.push({ text: content, type: partType });
      }
      return SSEChunkParser.finalizeChunkParts(parts, thinkingEnabled, newType, responseMessageId);
    }

    if (JsonGuard.isArray(val)) {
      const extracted = SSEChunkParser.extractContentRecursive(val, partType, stripRefMarkers);
      if (extracted.finished) {
        return SSEChunkParser.makeChunkResult(newType, responseMessageId, { finished: true });
      }
      parts.push(...extracted.parts);
      return SSEChunkParser.finalizeChunkParts(parts, thinkingEnabled, newType, responseMessageId);
    }

    if (JsonGuard.isObject(val)) {
      const directContent = SSEChunkParser.asContentString(val, stripRefMarkers);
      if (directContent) {
        parts.push({ text: directContent, type: partType });
      }
      const resp = JsonGuard.isObject(val.response) ? val.response : val;
      if (JsonGuard.isArray(resp.fragments)) {
        for (const frag of resp.fragments) {
          if (!JsonGuard.isObject(frag)) continue;
          const content = SSEChunkParser.asContentString(frag.content, stripRefMarkers);
          if (!content) continue;
          const fragCategory = SSEChunkParser.classifyFragmentType(
            JsonCodec.asCleanString(frag.type),
            partType,
          );
          newType = fragCategory;
          parts.push({ text: content, type: fragCategory });
        }
      }
    }

    return SSEChunkParser.finalizeChunkParts(parts, thinkingEnabled, newType, responseMessageId);
  }
}

// ─── Strategy / Calculator Pattern: TokenUsageCalculator ─────────────────────

/**
 * Strategy / Calculator Pattern: Estimates token counts and builds OpenAI `ChatUsage` objects,
 * plus continuation overlap deduplication.
 */
export class TokenUsageCalculator {
  public static trimContinuationOverlap(existing: string, incoming: string): string {
    if (!incoming) return '';
    if (!existing) return incoming;
    if (incoming.length >= MIN_CONTINUATION_SNAPSHOT_LEN && incoming.startsWith(existing)) {
      return incoming.slice(existing.length);
    }
    if (incoming.length >= MIN_CONTINUATION_SNAPSHOT_LEN && existing.startsWith(incoming)) {
      return '';
    }
    return incoming;
  }

  public static estimateTokens(text: string): number {
    if (!text) return 0;
    let asciiChars = 0;
    let nonASCIIChars = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 128) {
        asciiChars += 1;
      } else {
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
          const next = text.charCodeAt(i + 1);
          if (next >= 0xdc00 && next <= 0xdfff) {
            i += 1;
          }
        }
        nonASCIIChars += 1;
      }
    }
    const n = Math.floor(asciiChars / 4) + Math.floor((nonASCIIChars * 10 + 7) / 13);
    return n < 1 ? 1 : n;
  }

  public static buildUsage(
    prompt: string,
    thinking: string,
    output: string,
    outputTokens: number = 0,
    providedPromptTokens: number = 0,
  ): ChatUsage {
    const reasoningTokens = TokenUsageCalculator.estimateTokens(thinking);
    const completionTokens = TokenUsageCalculator.estimateTokens(output);
    const finalPromptTokens =
      Number.isFinite(providedPromptTokens) && providedPromptTokens > 0
        ? Math.trunc(providedPromptTokens)
        : TokenUsageCalculator.estimateTokens(prompt);
    const overriddenCompletionTokens =
      Number.isFinite(outputTokens) && outputTokens > 0 ? Math.trunc(outputTokens) : 0;
    const finalCompletionTokens =
      overriddenCompletionTokens > 0
        ? overriddenCompletionTokens
        : reasoningTokens + completionTokens;
    return {
      prompt_tokens: finalPromptTokens,
      completion_tokens: finalCompletionTokens,
      total_tokens: finalPromptTokens + finalCompletionTokens,
      completion_tokens_details: {
        reasoning_tokens: reasoningTokens,
      },
    };
  }
}

// ─── Async Iterator Pattern: SSEStreamReader ─────────────────────────────────

/**
 * Async Iterator Pattern: Reads Web-standard `ReadableStream<Uint8Array>` line-by-line
 * and yields parsed SSE `data:` JSON objects.
 */
export class SSEStreamReader {
  public static parseDataLine(rawLine: string): JsonObject | null {
    if (!rawLine || rawLine.startsWith(':') || !rawLine.startsWith(SSEConst.DATA_PREFIX)) {
      return null;
    }
    const dataStr = rawLine.slice(SSEConst.DATA_PREFIX.length).trim();
    if (!dataStr || dataStr === SSEConst.DONE_MARKER) {
      return null;
    }
    return JsonCodec.parseObject(dataStr);
  }

  public static async *iterateDataPayloads(
    stream: ReadableStream<Uint8Array>,
    signal?: AbortSignal | null,
  ): AsyncGenerator<JsonObject, void, void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (!signal?.aborted) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_SSE_BUFFER_LENGTH) {
          throw new Error('SSE stream line buffer exceeded maximum allowed size.');
        }
        let newlineIdx = buffer.indexOf('\n');
        while (newlineIdx >= 0) {
          const parsed = SSEStreamReader.parseDataLine(buffer.slice(0, newlineIdx).trim());
          buffer = buffer.slice(newlineIdx + 1);
          newlineIdx = buffer.indexOf('\n');
          if (parsed) {
            yield parsed;
          }
        }
      }
      const parsedTail = SSEStreamReader.parseDataLine((buffer + decoder.decode()).trim());
      if (parsedTail) {
        yield parsedTail;
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Ignore lock release errors
      }
    }
  }
}

export function stripThinkTags(text: string): string {
  return TextSanitizer.stripThinkTags(text);
}

export function stripReferenceMarkers(text: string): string {
  return TextSanitizer.stripReferenceMarkers(text);
}

export function parseChunkForContent(
  chunk: JsonObject | null | undefined,
  thinkingEnabled: boolean,
  currentType: FragmentCategory,
  stripRefMarkers: boolean = true,
): ParsedChunkResult {
  return SSEChunkParser.parseChunk(chunk, thinkingEnabled, currentType, stripRefMarkers);
}

export function extractContentRecursive(
  items: JsonArray,
  defaultType: FragmentCategory,
  stripRefMarkers: boolean = true,
): { parts: ParsedPart[]; finished: boolean } {
  return SSEChunkParser.extractContentRecursive(items, defaultType, stripRefMarkers);
}

export function filterLeakedContentFilterParts(parts: ParsedPart[]): ParsedPart[] {
  return TextSanitizer.filterLeakedContentFilterParts(parts);
}

export function hasContentFilterStatus(chunk: JsonValue | undefined): boolean {
  return SSEChunkParser.hasContentFilterStatus(chunk);
}

export function shouldSkipPath(pathValue: string): boolean {
  return SSEChunkParser.shouldSkipPath(pathValue);
}

export function isFragmentStatusPath(pathValue: string): boolean {
  return SSEChunkParser.isFragmentStatusPath(pathValue);
}

export function trimContinuationOverlap(existing: string, incoming: string): string {
  return TokenUsageCalculator.trimContinuationOverlap(existing, incoming);
}

export function estimateTokens(text: string): number {
  return TokenUsageCalculator.estimateTokens(text);
}

export function buildUsage(
  prompt: string,
  thinking: string,
  output: string,
  outputTokens: number = 0,
  providedPromptTokens: number = 0,
): ChatUsage {
  return TokenUsageCalculator.buildUsage(
    prompt,
    thinking,
    output,
    outputTokens,
    providedPromptTokens,
  );
}

export function iterateSSEDataPayloads(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal | null,
): AsyncGenerator<JsonObject, void, void> {
  return SSEStreamReader.iterateDataPayloads(stream, signal);
}
