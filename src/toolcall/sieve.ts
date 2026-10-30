/**
 * DeepSeek DSML / XML Tool-Call Prompt Generator, Parser, and Streaming Sieve.
 *
 * Design Patterns applied:
 * - State Machine Pattern (`ToolSieveStateMachine` managing `Idle` vs `Capturing` states)
 * - `ts-pattern` exhaustive matching for schema type coercion & XML tag normalization
 */

import { match, P } from 'ts-pattern';
import {
  isJsonArray,
  isJsonObject,
  JsonGuard,
  JsonObject,
  JsonValue,
  randomId,
  safeJsonParse,
  safeJsonParseObject,
} from '../types/json.js';
import type {
  OpenAIStreamToolCall,
  OpenAIToolCall,
  ParsedToolCall,
  ToolCallParseResult,
  ToolFunctionSpec,
  ToolsCollectionInput,
  ToolSchemaInput,
  ToolSieveEvent,
  ToolSieveState,
} from '../@types/toolcall.js';

export type {
  OpenAIStreamToolCall,
  OpenAIToolCall,
  ParsedToolCall,
  ToolCallParseResult,
  ToolFunctionSpec,
  ToolsCollectionInput,
  ToolSchemaInput,
  ToolSieveEvent,
  ToolSieveState,
};

export function promptCDATA(text: string): string {
  if (!text) return '';
  if (text.includes(']]>')) {
    return `<![CDATA[${text.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
  }
  return `<![CDATA[${text}]]>`;
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/\x22/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function wrapParameter(name: string, inner: string): string {
  return `<|DSML|parameter name="${escapeXmlAttr(name)}">${inner}</|DSML|parameter>`;
}

export function buildToolCallInstructions(toolNames: string[]): string {
  return (
    `TOOL CALL FORMAT — FOLLOW EXACTLY:

<|DSML|tool_calls>
  <|DSML|invoke name="TOOL_NAME_HERE">
    <|DSML|parameter name="PARAMETER_NAME"><![CDATA[PARAMETER_VALUE]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>

RULES:
1) Use the <|DSML|tool_calls> wrapper format.
2) Put one or more <|DSML|invoke> entries under a single <|DSML|tool_calls> root.
3) Put the tool name in the invoke name attribute: <|DSML|invoke name="TOOL_NAME">.
3a) Tag punctuation alphabet: ASCII < > / = " plus the halfwidth pipe |.
4) All string values must use <![CDATA[...]]>, even short ones. This includes code, scripts, file contents, prompts, paths, names, and queries.
5) Every top-level argument must be a <|DSML|parameter name="ARG_NAME">...</|DSML|parameter> node.
6) Objects use nested XML elements inside the parameter body. Arrays may repeat <item> children.
7) Numbers, booleans, and null stay plain text.
8) Use only the parameter names in the tool schema. Do not invent fields.
9) Fill parameters with the actual values required for this call. Do not emit placeholder, blank, or whitespace-only parameters.
10) If a required parameter value is unknown, ask the user or answer normally instead of outputting an empty tool call.
11) For shell tools such as Bash / execute_command, the command/script must be inside the command parameter. Never call them with an empty command.
12) Do NOT wrap XML in markdown fences. Do NOT output explanations, role markers, or internal monologue.
13) If you call a tool, the first non-whitespace characters of that tool block must be exactly <|DSML|tool_calls>.
14) Never omit the opening <|DSML|tool_calls> tag, even if you already plan to close with </|DSML|tool_calls>.
15) Compatibility note: the runtime also accepts the legacy XML tags <tool_calls> / <invoke> / <parameter>, but prefer the DSML-prefixed form above.

PARAMETER SHAPES:
- string => <|DSML|parameter name="x"><![CDATA[value]]></|DSML|parameter>
- object => <|DSML|parameter name="x"><field>...</field></|DSML|parameter>
- array => <|DSML|parameter name="x"><item>...</item><item>...</item></|DSML|parameter>
- number/bool/null => <|DSML|parameter name="x">plain_text</|DSML|parameter>

Remember: The ONLY valid way to use tools is the <|DSML|tool_calls>...</|DSML|tool_calls> block at the end of your response.` +
    (toolNames.length > 0 ? `\nAvailable tool names: ${toolNames.join(', ')}` : '')
  );
}

const DSML_TAG = Object.freeze({
  TOOL_CALLS_OPEN: '<|DSML|tool_calls>',
  TOOL_CALLS_CLOSE: '</|DSML|tool_calls>',
  INVOKE_CLOSE: '  </|DSML|invoke>',
  CANONICAL_TOOL_CALLS: 'tool_calls',
  FUNCTION_TYPE: 'function',
  CALL_ID_PREFIX: 'call',
} as const);

const SIEVE_EVENT_TYPE = Object.freeze({
  TEXT: 'text',
  TOOL_CALLS: 'tool_calls',
} as const);

function resolveToolParameters(fnObj: ToolFunctionSpec | JsonObject): JsonObject {
  if (isJsonObject(fnObj.parameters as JsonValue | undefined)) {
    return fnObj.parameters as JsonObject;
  }
  if (isJsonObject(fnObj.input_schema as JsonValue | undefined)) {
    return fnObj.input_schema as JsonObject;
  }
  if (isJsonObject(fnObj.schema as JsonValue | undefined)) {
    return fnObj.schema as JsonObject;
  }
  return {};
}

export function extractToolMeta(tool: ToolSchemaInput | JsonObject): {
  name: string;
  description: string;
  parameters: JsonObject;
} {
  const fnObj: ToolFunctionSpec | JsonObject =
    'function' in tool &&
    tool.function &&
    typeof tool.function === 'object' &&
    !Array.isArray(tool.function)
      ? (tool.function as ToolFunctionSpec)
      : tool;
  const name = typeof fnObj.name === 'string' ? fnObj.name.trim() : '';
  const description = typeof fnObj.description === 'string' ? fnObj.description.trim() : '';
  const parameters = resolveToolParameters(fnObj);
  return { name, description, parameters };
}

export function extractToolNames(tools: ToolsCollectionInput): string[] {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const { name } = extractToolMeta(t);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function formatToolCallsForPrompt(
  toolCallsRaw: ReadonlyArray<OpenAIToolCall | ToolSchemaInput | JsonObject> | undefined | null,
): string {
  if (!Array.isArray(toolCallsRaw) || toolCallsRaw.length === 0) return '';
  const lines: string[] = [DSML_TAG.TOOL_CALLS_OPEN];
  let count = 0;
  for (const item of toolCallsRaw) {
    if (!item || typeof item !== 'object') continue;
    const fn: ToolFunctionSpec | JsonObject =
      'function' in item &&
      item.function &&
      typeof item.function === 'object' &&
      !Array.isArray(item.function)
        ? (item.function as ToolFunctionSpec)
        : (item as JsonObject);
    const name = typeof fn.name === 'string' ? fn.name.trim() : '';
    if (!name) continue;

    let argsObj: JsonObject = {};
    if (typeof fn.arguments === 'string') {
      const parsed = safeJsonParseObject(fn.arguments);
      argsObj = parsed ?? { content: fn.arguments };
    } else if ('input' in fn && isJsonObject(fn.input as JsonValue | undefined)) {
      argsObj = fn.input as JsonObject;
    } else if ('arguments' in fn && isJsonObject(fn.arguments as JsonValue | undefined)) {
      argsObj = fn.arguments as JsonObject;
    }

    lines.push(`  <|DSML|invoke name="${escapeXmlAttr(name)}">`);
    for (const [k, v] of Object.entries(argsObj)) {
      if (!JsonGuard.isSafeKey(k)) continue;
      if (typeof v === 'string') {
        lines.push(`    ${wrapParameter(k, promptCDATA(v))}`);
      } else {
        lines.push(`    ${wrapParameter(k, JSON.stringify(v ?? null))}`);
      }
    }
    lines.push(DSML_TAG.INVOKE_CLOSE);
    count++;
  }
  lines.push(DSML_TAG.TOOL_CALLS_CLOSE);
  return count > 0 ? lines.join('\n') : '';
}

const FULLWIDTH_PUNCTS_REGEX = /[〈＜﹤〉＞﹥｜│∣／]/;

function normalizeFullwidthASCII(str: string): string {
  if (!FULLWIDTH_PUNCTS_REGEX.test(str)) return str;
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    out += match(ch)
      .with(P.union('〈', '＜', '﹤'), () => '<')
      .with(P.union('〉', '＞', '﹥'), () => '>')
      .with(P.union('｜', '│', '∣'), () => '|')
      .with('／', () => '/')
      .otherwise((c) => c);
  }
  return out;
}

function canonicalizeTagName(tag: string): string {
  const lower = tag.toLowerCase();
  return lower.startsWith('tool') || lower.startsWith('function') ? 'tool_calls' : lower;
}

export function normalizeDSMLToolCallMarkup(text: string): string {
  if (!text) return '';
  const norm = normalizeFullwidthASCII(text);
  return norm
    .replace(
      /<\s*(?:\/\s*\|\s*DSML\s*\||\|\s*\/\s*DSML\s*\|)\s*(tool_calls|tool-calls|toolcalls|function_calls|function-calls|functioncalls|invoke|parameter)\s*>/gi,
      (_m, tag: string) => `</${canonicalizeTagName(tag)}>`,
    )
    .replace(
      /<\s*\|\s*DSML\s*\|\s*(tool_calls|tool-calls|toolcalls|function_calls|function-calls|functioncalls|invoke|parameter)\b/gi,
      (_m, tag: string) => `<${canonicalizeTagName(tag)}`,
    );
}

function stripFencedCodeBlocks(text: string): string {
  if (!text) return '';
  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let inCDATA = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineWithNL = i < lines.length - 1 ? `${line}\n` : line;
    if (inCDATA || line.includes('<![CDATA[')) {
      out.push(lineWithNL);
      if (line.includes('<![CDATA[') && !line.includes(']]>')) {
        inCDATA = true;
      } else if (line.includes(']]>')) {
        inCDATA = false;
      }
      continue;
    }
    const trimmed = line.replace(/^[ \t]+/, '');
    if (!inFence) {
      const m = /^(`{3,}|~{3,})/.exec(trimmed);
      if (m) {
        inFence = true;
        fenceChar = m[1][0];
        fenceLen = m[1].length;
        continue;
      }
      out.push(lineWithNL);
    } else {
      const m = /^(`{3,}|~{3,})\s*$/.exec(trimmed);
      if (m && m[1][0] === fenceChar && m[1].length >= fenceLen) {
        inFence = false;
      }
    }
  }
  return out.join('');
}

function extractCDATAOrText(raw: string): { isCDATA: boolean; value: string } {
  const trimmed = raw.trim();
  const m = /^<!\[CDATA\[([\s\S]*?)]]>$/i.exec(trimmed);
  if (m) {
    return { isCDATA: true, value: m[1] };
  }
  return {
    isCDATA: false,
    value: trimmed
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&#x27;/g, "'"),
  };
}

const STRING_PRESERVE_PARAMS = new Set([
  'content',
  'file_content',
  'text',
  'prompt',
  'query',
  'command',
  'cmd',
  'script',
  'code',
  'old_string',
  'new_string',
  'pattern',
  'path',
  'file_path',
]);

function appendObjectValue(obj: JsonObject, key: string, val: JsonValue): void {
  if (!JsonGuard.isSafeKey(key)) return;
  if (JsonGuard.hasOwn(obj, key) && obj[key] !== undefined) {
    const existing = obj[key];
    if (isJsonArray(existing)) {
      existing.push(val);
    } else {
      obj[key] = [existing, val];
    }
  } else {
    obj[key] = val;
  }
}

function parseParameterValue(rawBody: string, paramName: string): JsonValue {
  const { isCDATA, value } = extractCDATAOrText(rawBody);
  if (isCDATA && STRING_PRESERVE_PARAMS.has(paramName.toLowerCase())) {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) return '';

  // Check for nested <item> tags
  const itemMatches = Array.from(trimmed.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi));
  if (itemMatches.length > 0 && trimmed.startsWith('<item')) {
    return itemMatches.map((m) => parseParameterValue(m[1], ''));
  }

  // Check for generic XML key-value children when not CDATA string
  if (!isCDATA && trimmed.startsWith('<') && trimmed.endsWith('>')) {
    const childMatches = Array.from(
      trimmed.matchAll(/<([a-zA-Z_][a-zA-Z0-9_.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g),
    );
    if (childMatches.length > 0) {
      const obj: JsonObject = {};
      for (const cm of childMatches) {
        const key = cm[1];
        appendObjectValue(obj, key, parseParameterValue(cm[2], key));
      }
      if (Object.keys(obj).length === 1 && obj.item !== undefined) {
        return isJsonArray(obj.item) ? obj.item : [obj.item];
      }
      return obj;
    }
  }

  // Try JSON literal if it starts with JSON token
  if (/^(?:true|false|null|-?\d+(?:\.\d+)?|\{[\s\S]*\}|\[[\s\S]*\])$/i.test(trimmed)) {
    const parsed = safeJsonParse(trimmed);
    if (parsed !== null || trimmed.toLowerCase() === 'null') {
      return parsed;
    }
  }
  return value;
}

export function parseMarkupToolCalls(rawText: string): ParsedToolCall[] {
  const normalized = normalizeDSMLToolCallMarkup(rawText);
  let target = normalized;
  if (
    !/<tool_calls\b/i.test(target) &&
    /<invoke\b/i.test(target) &&
    /<\/tool_calls>/i.test(target)
  ) {
    const idx = target.search(/<invoke\b/i);
    target = `${target.slice(0, idx)}<tool_calls>${target.slice(idx)}`;
  }

  const out: ParsedToolCall[] = [];
  const wrapperRegex = /<tool_calls\b[^>]*>([\s\S]*?)<\/tool_calls>/gi;
  for (const wrapperMatch of target.matchAll(wrapperRegex)) {
    const wrapperBody = wrapperMatch[1];
    const invokeRegex = /<invoke\b([^>]*)>([\s\S]*?)<\/invoke>/gi;
    for (const invokeMatch of wrapperBody.matchAll(invokeRegex)) {
      const attrs = invokeMatch[1];
      const invokeBody = invokeMatch[2];
      const nameMatch = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
      const name = (nameMatch?.[1] ?? nameMatch?.[2] ?? '').trim();
      if (!name) continue;

      const input: JsonObject = {};
      const paramRegex = /<parameter\b([^>]*)>([\s\S]*?)<\/parameter>/gi;
      let foundParam = false;
      for (const paramMatch of invokeBody.matchAll(paramRegex)) {
        foundParam = true;
        const pAttrs = paramMatch[1];
        const pBody = paramMatch[2];
        const pNameMatch = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(pAttrs);
        const pName = (pNameMatch?.[1] ?? pNameMatch?.[2] ?? '').trim();
        if (!pName) continue;
        appendObjectValue(input, pName, parseParameterValue(pBody, pName));
      }

      if (!foundParam && invokeBody.trim().startsWith('{')) {
        const parsedJson = safeJsonParseObject(invokeBody.trim());
        if (parsedJson) {
          for (const [k, v] of Object.entries(parsedJson)) {
            if (JsonGuard.isSafeKey(k)) {
              input[k] = v;
            }
          }
        }
      }

      out.push({ name, input });
    }
  }
  return out;
}

const ANY_TOOL_SENTINEL = '__any_tool__';

export function parseToolCallsDetailed(text: string, toolNames?: string[]): ToolCallParseResult {
  const empty: ToolCallParseResult = {
    calls: [],
    sawToolCallSyntax: false,
    rejectedByPolicy: false,
    rejectedToolNames: [],
  };
  if (!text || typeof text !== 'string') return empty;
  const stripped = stripFencedCodeBlocks(text);
  const rawCalls = parseMarkupToolCalls(stripped);
  if (rawCalls.length === 0) {
    return empty;
  }

  if (Array.isArray(toolNames) && toolNames.length > 0 && !toolNames.includes(ANY_TOOL_SENTINEL)) {
    const allowedMap = new Map<string, string>();
    for (const allowedName of toolNames) {
      const clean = allowedName.trim();
      if (clean) {
        allowedMap.set(clean.toLowerCase(), clean);
      }
    }
    const accepted: ParsedToolCall[] = [];
    const rejectedToolNames: string[] = [];
    for (const call of rawCalls) {
      const canonical = allowedMap.get(call.name.toLowerCase());
      if (canonical) {
        accepted.push({ name: canonical, input: call.input });
      } else {
        rejectedToolNames.push(call.name);
      }
    }
    return {
      calls: accepted,
      sawToolCallSyntax: true,
      rejectedByPolicy: rejectedToolNames.length > 0,
      rejectedToolNames,
    };
  }

  return {
    calls: rawCalls,
    sawToolCallSyntax: true,
    rejectedByPolicy: false,
    rejectedToolNames: [],
  };
}

export function parseStandaloneToolCallsDetailed(
  text: string,
  toolNames?: string[],
): ToolCallParseResult {
  return parseToolCallsDetailed(text, toolNames);
}

function coerceValueBySchemaType(
  val: JsonValue | undefined,
  schemaType: string | undefined,
): JsonValue | undefined {
  if (val === undefined) return undefined;
  return match(schemaType)
    .with('string', () => {
      if (typeof val === 'string' || val === null) {
        return val;
      }
      return JSON.stringify(val);
    })
    .with(P.union('number', 'integer'), () =>
      typeof val === 'string' && val.trim() !== '' && !Number.isNaN(Number(val))
        ? Number(val)
        : val,
    )
    .with('boolean', () => {
      if (typeof val !== 'string') return val;
      return match(val.toLowerCase())
        .with('true', () => true)
        .with('false', () => false)
        .otherwise(() => val);
    })
    .otherwise(() => val);
}

export function normalizeParsedToolCallsForSchemas(
  calls: ParsedToolCall[],
  toolsRaw?: ToolsCollectionInput,
): ParsedToolCall[] {
  if (!Array.isArray(calls) || calls.length === 0 || !Array.isArray(toolsRaw)) {
    return calls;
  }
  const schemaMap = new Map<string, JsonObject>();
  for (const t of toolsRaw) {
    if (!t || typeof t !== 'object') continue;
    const { name, parameters } = extractToolMeta(t);
    if (name && isJsonObject(parameters)) {
      schemaMap.set(name.toLowerCase(), parameters);
    }
  }

  return calls.map((call) => {
    const schema = schemaMap.get(call.name.toLowerCase());
    if (!schema || !isJsonObject(schema.properties)) return call;
    const props = schema.properties;
    const nextInput: JsonObject = { ...call.input };
    for (const [k, v] of Object.entries(nextInput)) {
      if (!JsonGuard.isSafeKey(k) || !JsonGuard.hasOwn(props, k)) continue;
      const propSchema = props[k];
      if (!isJsonObject(propSchema)) continue;
      const schemaType = typeof propSchema.type === 'string' ? propSchema.type : undefined;
      nextInput[k] = coerceValueBySchemaType(v, schemaType);
    }
    return { name: call.name, input: nextInput };
  });
}

export function formatOpenAIToolCalls(
  calls: ParsedToolCall[],
  toolsRaw?: ToolsCollectionInput,
): OpenAIToolCall[] {
  const normalized = normalizeParsedToolCallsForSchemas(calls, toolsRaw);
  return normalized.map((c) => ({
    id: randomId(DSML_TAG.CALL_ID_PREFIX),
    type: DSML_TAG.FUNCTION_TYPE,
    function: {
      name: c.name,
      arguments: JSON.stringify(c.input ?? {}),
    },
  }));
}

export function formatOpenAIStreamToolCalls(
  calls: ParsedToolCall[],
  idStore?: Map<number, string>,
  toolsRaw?: ToolsCollectionInput,
): OpenAIStreamToolCall[] {
  const normalized = normalizeParsedToolCallsForSchemas(calls, toolsRaw);
  return normalized.map((c, idx) => {
    let id = idStore?.get(idx);
    if (!id) {
      id = randomId(DSML_TAG.CALL_ID_PREFIX);
      idStore?.set(idx, id);
    }
    return {
      index: idx,
      id,
      type: DSML_TAG.FUNCTION_TYPE,
      function: {
        name: c.name,
        arguments: JSON.stringify(c.input ?? {}),
      },
    };
  });
}

export function createToolSieveState(): ToolSieveState {
  return {
    pending: '',
    capture: '',
    capturing: false,
    codeFenceStack: [],
    codeFencePendingTicks: 0,
    codeFencePendingTildes: 0,
    codeFenceLineStart: true,
    markdownCodeSpanTicks: 0,
    pendingToolRaw: '',
    pendingToolCalls: [],
  };
}

const OPEN_TAG_REGEX =
  /<(?:\/?\s*[|｜]\s*DSML\s*[|｜]\s*(?:tool_calls|tool-calls|toolcalls|function_calls|function-calls|functioncalls|invoke)|(?:tool_calls|function_calls)\b)/i;
const CLOSE_TAG_REGEX =
  /<(?:\s*\/\s*[|｜]\s*DSML\s*[|｜]\s*|\s*[|｜]\s*\/\s*DSML\s*[|｜]\s*|\/)(?:tool_calls|tool-calls|toolcalls|function_calls|function-calls|functioncalls)\s*>/i;

function findPartialTagStart(text: string): number {
  const lastLT = text.lastIndexOf('<');
  if (lastLT < 0) return -1;
  const tail = text.slice(lastLT);
  if (tail.includes('>')) return -1;
  const cleanTail = normalizeFullwidthASCII(tail).toLowerCase().replace(/\s+/g, '');
  const prefixes = [
    '<|dsml|tool_calls',
    '<|dsml|function_calls',
    '<|dsml|invoke',
    '<tool_calls',
    '<function_calls',
    '</|dsml|tool_calls',
    '</|dsml|function_calls',
    '</tool_calls',
    '</function_calls',
  ];
  for (const p of prefixes) {
    if (p.startsWith(cleanTail) || cleanTail.startsWith(p)) {
      return lastLT;
    }
  }
  return -1;
}

/**
 * State Machine encapsulating streaming XML/DSML tool-call capture and release.
 */
export class ToolSieveStateMachine {
  public readonly state: ToolSieveState;
  private readonly toolNames?: string[];

  constructor(toolNames?: string[], initialState?: ToolSieveState) {
    this.state = initialState ?? createToolSieveState();
    this.toolNames = toolNames;
  }

  public feed(chunk: string): ToolSieveEvent[] {
    return processToolSieveChunk(this.state, chunk, this.toolNames);
  }

  public flush(): ToolSieveEvent[] {
    return flushToolSieve(this.state, this.toolNames);
  }
}

export function processToolSieveChunk(
  state: ToolSieveState,
  chunk: string,
  toolNames?: string[],
): ToolSieveEvent[] {
  if (chunk) {
    state.pending += chunk;
  }
  const events: ToolSieveEvent[] = [];

  while (true) {
    if (state.capturing) {
      if (state.pending) {
        state.capture += state.pending;
        state.pending = '';
      }
      const closeMatch = CLOSE_TAG_REGEX.exec(state.capture);
      if (!closeMatch) {
        break;
      }
      const closeEnd = closeMatch.index + closeMatch[0].length;
      const xmlBlock = state.capture.slice(0, closeEnd);
      const suffix = state.capture.slice(closeEnd);
      state.capture = '';
      state.capturing = false;

      const parsed = parseToolCallsDetailed(xmlBlock, toolNames);
      if (parsed.calls.length > 0) {
        events.push({ type: SIEVE_EVENT_TYPE.TOOL_CALLS, calls: parsed.calls });
      } else {
        events.push({ type: SIEVE_EVENT_TYPE.TEXT, text: xmlBlock });
      }
      if (suffix) {
        state.pending = suffix + state.pending;
        continue;
      }
      break;
    }

    if (!state.pending) break;
    const openMatch = OPEN_TAG_REGEX.exec(state.pending);
    if (openMatch) {
      const prefix = state.pending.slice(0, openMatch.index);
      if (prefix) {
        events.push({ type: SIEVE_EVENT_TYPE.TEXT, text: prefix });
      }
      state.capture = state.pending.slice(openMatch.index);
      state.pending = '';
      state.capturing = true;
      continue;
    }

    const partialStart = findPartialTagStart(state.pending);
    if (partialStart >= 0) {
      if (partialStart > 0) {
        events.push({ type: SIEVE_EVENT_TYPE.TEXT, text: state.pending.slice(0, partialStart) });
        state.pending = state.pending.slice(partialStart);
      }
      break;
    }

    events.push({ type: SIEVE_EVENT_TYPE.TEXT, text: state.pending });
    state.pending = '';
    break;
  }

  return events;
}

export function flushToolSieve(state: ToolSieveState, toolNames?: string[]): ToolSieveEvent[] {
  const events = processToolSieveChunk(state, '', toolNames);
  if (state.capturing && state.capture) {
    const parsed = parseToolCallsDetailed(state.capture, toolNames);
    if (parsed.calls.length > 0) {
      events.push({ type: SIEVE_EVENT_TYPE.TOOL_CALLS, calls: parsed.calls });
    } else {
      events.push({ type: SIEVE_EVENT_TYPE.TEXT, text: state.capture });
    }
    state.capture = '';
    state.capturing = false;
  }
  if (state.pending) {
    events.push({ type: SIEVE_EVENT_TYPE.TEXT, text: state.pending });
    state.pending = '';
  }
  return events;
}
