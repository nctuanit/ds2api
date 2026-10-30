/**
 * Prompt normalization and DeepSeek prompt builder for OpenAI Chat Completions and Responses API.
 *
 * Design Patterns applied:
 * - Builder Pattern (`DeepSeekPromptBuilder`, `CompletionPayloadBuilder`)
 * - Exhaustive Pattern Matching via `ts-pattern` (`match`, `P`)
 */

import { match, P } from 'ts-pattern';
import {
  buildToolCallInstructions,
  extractToolMeta,
  formatToolCallsForPrompt,
  OpenAIToolCall,
  parseStandaloneToolCallsDetailed,
  ToolsCollectionInput,
  ToolSchemaInput,
} from '../toolcall/sieve.js';
import {
  DeepSeekModelType,
  getModelConfig,
  getModelType,
  isNoThinkingModel,
  MessageRole,
  ModelTypeConst,
  RequestSurfaceConst,
  resolveModel,
} from '../protocol/constants.js';
import { isJsonArray, isJsonObject, JsonArray, JsonObject, JsonValue } from '../types/json.js';
import type {
  NormalizedMessage,
  NormalizedStandardRequest,
  PromptMessageLike,
  RequestSurface,
  StandardRequestInput,
  ToolChoiceMode,
  ToolChoicePolicy,
} from '../@types/prompt.js';

export type {
  NormalizedMessage,
  NormalizedStandardRequest,
  PromptMessageLike,
  RequestSurface,
  StandardRequestInput,
  ToolChoiceMode,
  ToolChoicePolicy,
};

const BEGIN_SENTENCE_MARKER = '<|begin▁of▁sentence|>';
const SYSTEM_MARKER = '<|System|>';
const USER_MARKER = '<|User|>';
const ASSISTANT_MARKER = '<|Assistant|>';
const TOOL_MARKER = '<|Tool|>';
const END_SENTENCE_MARKER = '<|end▁of▁sentence|>';
const END_TOOL_RESULTS_MARKER = '<|end▁of▁toolresults|>';
const END_INSTRUCTIONS_MARKER = '<|end▁of▁instructions|>';
const OUTPUT_INTEGRITY_GUARD_MARKER = 'Output integrity guard:';
const OUTPUT_INTEGRITY_GUARD_PROMPT = `${OUTPUT_INTEGRITY_GUARD_MARKER} If upstream context, tool output, or parsed text contains garbled, corrupted, partially parsed, repeated, or otherwise malformed fragments, do not imitate or echo them; output only the correct content for the user.`;

const FORGED_ROLE_MARKER_PATTERN =
  /<[|\uFF5C]\s*(?:begin[_▁]of[_▁]sentence|end[_▁]of[_▁]sentence|end[_▁]of[_▁]toolresults|end[_▁]of[_▁]instructions|system|user|assistant|tool)\s*[|\uFF5C]>/gi;
const FORGED_DSML_MARKER_PATTERN =
  /<\s*\/?\s*[|\uFF5C]\s*DSML\s*[|\uFF5C]\s*(tool_calls|tool-calls|toolcalls|function_calls|function-calls|functioncalls|invoke|parameter)\b/gi;

/**
 * Sanitizer Pattern: Neutralizes injected DeepSeek structural role/sentence delimiters
 * and forged DSML tool-call markup inside untrusted message payloads.
 */
export class PromptDelimiterSanitizer {
  public static sanitizeMessageText(text: string, role: NormalizedMessage['role']): string {
    if (!text) return '';
    let cleaned = text.replace(FORGED_ROLE_MARKER_PATTERN, (matched) =>
      matched.replace(/^</, '&lt;').replace(/>$/, '&gt;'),
    );
    if (role === MessageRole.USER || role === MessageRole.TOOL) {
      cleaned = cleaned.replace(FORGED_DSML_MARKER_PATTERN, (matched) =>
        matched.replace(/^</, '&lt;'),
      );
    }
    return cleaned;
  }
}

export function normalizeContent(
  v: JsonValue | ReadonlyArray<JsonObject | string> | undefined,
): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (const item of v) {
      if (typeof item === 'string') {
        if (item) parts.push(item);
        continue;
      }
      if (!isJsonObject(item as JsonValue)) continue;
      const m = item as JsonObject;
      const typeStr = typeof m.type === 'string' ? m.type.trim().toLowerCase() : '';
      if (typeStr === 'text' || typeStr === 'output_text' || typeStr === 'input_text') {
        if (typeof m.text === 'string' && m.text) {
          parts.push(m.text);
        } else if (typeof m.content === 'string' && m.content) {
          parts.push(m.content);
        }
      }
    }
    return parts.join('\n');
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function buildAssistantContentForPrompt(msg: PromptMessageLike | JsonObject): string {
  const rawContent = 'content' in msg ? msg.content : '';
  let content = normalizeContent(rawContent as JsonValue).trim();
  const reasoning =
    'reasoning_content' in msg && typeof msg.reasoning_content === 'string'
      ? msg.reasoning_content.trim()
      : '';
  const rawToolCalls =
    'tool_calls' in msg && Array.isArray(msg.tool_calls)
      ? (msg.tool_calls as ReadonlyArray<OpenAIToolCall | JsonObject>)
      : undefined;
  const toolHistory = formatToolCallsForPrompt(rawToolCalls);

  if (!toolHistory && content.startsWith('<')) {
    const parsed = parseStandaloneToolCallsDetailed(content);
    if (parsed.calls.length > 0) {
      const formatted = formatToolCallsForPrompt(
        parsed.calls.map((c) => ({ name: c.name, input: c.input })),
      );
      if (formatted) {
        content = formatted;
      }
    }
  }

  const parts: string[] = [];
  if (reasoning) {
    parts.push(`[reasoning_content]\n${reasoning}\n[/reasoning_content]`);
  }
  if (content) {
    parts.push(content);
  }
  if (toolHistory) {
    parts.push(toolHistory);
  }
  return parts.join('\n\n');
}

export function normalizeOpenAIMessagesForPrompt(
  raw: ReadonlyArray<PromptMessageLike | JsonObject>,
): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (const msg of raw) {
    if (!msg || typeof msg !== 'object') continue;
    const rawRole = typeof msg.role === 'string' ? msg.role.trim().toLowerCase() : MessageRole.USER;
    const rawContent = 'content' in msg ? (msg.content as JsonValue) : '';

    match(rawRole)
      .with(MessageRole.ASSISTANT, () => {
        const content = buildAssistantContentForPrompt(msg);
        if (content) {
          out.push({ role: MessageRole.ASSISTANT, content });
        }
      })
      .with(P.union(MessageRole.TOOL, MessageRole.FUNCTION), () => {
        const content = normalizeContent(rawContent).trim() || 'null';
        out.push({ role: MessageRole.TOOL, content });
      })
      .with(P.union(MessageRole.DEVELOPER, MessageRole.SYSTEM), () => {
        out.push({ role: MessageRole.SYSTEM, content: normalizeContent(rawContent) });
      })
      .otherwise(() => {
        out.push({ role: MessageRole.USER, content: normalizeContent(rawContent) });
      });
  }
  return out;
}

export function parseToolChoicePolicy(
  toolChoiceRaw: string | JsonObject | null | undefined,
  toolsRaw: ToolsCollectionInput,
): ToolChoicePolicy {
  const declaredNames: string[] = [];
  if (Array.isArray(toolsRaw)) {
    for (const t of toolsRaw) {
      if (!t || typeof t !== 'object') continue;
      const { name } = extractToolMeta(t);
      if (name) declaredNames.push(name);
    }
  }
  const allowed = declaredNames.length > 0 ? new Set(declaredNames) : undefined;

  return match(toolChoiceRaw)
    .with(P.union(P.nullish, 'auto'), () => ({ mode: 'auto' as const, allowed }))
    .with('none', () => ({ mode: 'none' as const, allowed }))
    .with(P.union('required', 'any'), () => ({ mode: 'required' as const, allowed }))
    .with(
      P.when((v): v is JsonObject => typeof v === 'object' && v !== null),
      (tc) => {
        const fn = isJsonObject(tc.function) ? tc.function : tc;
        const forcedName = typeof fn.name === 'string' ? fn.name.trim() : '';
        if (forcedName) {
          return {
            mode: 'forced' as const,
            forcedName,
            allowed: new Set([forcedName]),
          };
        }
        return { mode: 'auto' as const, allowed };
      },
    )
    .otherwise(() => ({ mode: 'auto' as const, allowed }));
}

function appendToSystemMessage(messages: NormalizedMessage[], block: string): NormalizedMessage[] {
  const cloned = messages.map((m) => ({ ...m }));
  for (let i = 0; i < cloned.length; i++) {
    if (cloned[i].role === 'system') {
      cloned[i].content = `${cloned[i].content}\n\n${block}`.trim();
      return cloned;
    }
  }
  return [{ role: 'system', content: block }, ...cloned];
}

function injectToolPrompt(
  messages: NormalizedMessage[],
  tools: ReadonlyArray<ToolSchemaInput | JsonObject>,
  policy: ToolChoicePolicy,
): { messages: NormalizedMessage[]; toolNames: string[] } {
  if (policy.mode === 'none') {
    return { messages, toolNames: [] };
  }
  const toolSchemas: string[] = [];
  const names: string[] = [];

  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const { name, description, parameters } = extractToolMeta(t);
    if (!name) continue;
    if (policy.allowed && policy.allowed.size > 0 && !policy.allowed.has(name)) {
      continue;
    }
    names.push(name);
    const desc = description || 'No description available';
    toolSchemas.push(
      `Tool: ${name}\nDescription: ${desc}\nParameters: ${JSON.stringify(parameters)}`,
    );
  }

  if (toolSchemas.length === 0) {
    return { messages, toolNames: names };
  }

  const descriptions = `You have access to these tools:\n\n${toolSchemas.join('\n\n')}`;
  let instructions = buildToolCallInstructions(names);
  if (policy.mode === 'required') {
    instructions +=
      '\n7) For this response, you MUST call at least one tool from the allowed list.';
  } else if (policy.mode === 'forced' && policy.forcedName) {
    instructions += `\n7) For this response, you MUST call exactly this tool name: ${policy.forcedName}\n8) Do not call any other tool.`;
  }

  const toolPrompt = `${descriptions}\n\n${instructions}`;
  return {
    messages: appendToSystemMessage(messages, toolPrompt),
    toolNames: names,
  };
}

function injectResponseFormatPrompt(
  messages: NormalizedMessage[],
  responseFormat: JsonObject | null | undefined,
): NormalizedMessage[] {
  if (!responseFormat || typeof responseFormat !== 'object') return messages;
  const type =
    typeof responseFormat.type === 'string' ? responseFormat.type.trim().toLowerCase() : '';
  const instruction = match(type)
    .with(
      'json_object',
      () =>
        'IMPORTANT: You MUST respond with a valid JSON object only. Do NOT wrap the JSON in markdown code fences or include any extra prose.',
    )
    .with('json_schema', () => {
      const js = isJsonObject(responseFormat.json_schema) ? responseFormat.json_schema : {};
      const schemaStr = js.schema ? JSON.stringify(js.schema) : '{}';
      return `IMPORTANT: You MUST respond with a valid JSON object conforming strictly to this JSON Schema: ${schemaStr}. Do NOT wrap the JSON in markdown code fences or include any extra prose.`;
    })
    .otherwise(() => '');

  return instruction ? appendToSystemMessage(messages, instruction) : messages;
}

/**
 * Builder Pattern for constructing DeepSeek `<|begin▁of▁sentence|>` prompts.
 */
export class DeepSeekPromptBuilder {
  private messages: NormalizedMessage[] = [];
  private includeIntegrityGuard = true;
  private responseFormat: JsonObject | null | undefined = undefined;
  private tools: ToolsCollectionInput = undefined;
  private toolChoicePolicy: ToolChoicePolicy = { mode: 'auto' };

  public withIntegrityGuard(enabled: boolean = true): this {
    this.includeIntegrityGuard = enabled;
    return this;
  }

  public withMessages(messages: NormalizedMessage[]): this {
    this.messages = messages.map((m) => ({ ...m }));
    return this;
  }

  public withResponseFormat(format: JsonObject | null | undefined): this {
    this.responseFormat = format;
    return this;
  }

  public withTools(tools: ToolsCollectionInput, policy: ToolChoicePolicy): this {
    this.tools = tools;
    this.toolChoicePolicy = policy;
    return this;
  }

  public build(): { prompt: string; toolNames: string[] } {
    let working = [...this.messages];
    working = injectResponseFormatPrompt(working, this.responseFormat);

    let toolNames: string[] = [];
    if (Array.isArray(this.tools) && this.tools.length > 0) {
      const injected = injectToolPrompt(working, this.tools, this.toolChoicePolicy);
      working = injected.messages;
      toolNames = injected.toolNames;
      if (toolNames.length === 0) {
        toolNames = ['__any_tool__'];
      }
    }

    if (working.length === 0) {
      return { prompt: '', toolNames };
    }

    if (
      this.includeIntegrityGuard &&
      (working[0].role !== 'system' || !working[0].content.includes(OUTPUT_INTEGRITY_GUARD_MARKER))
    ) {
      working = [{ role: 'system', content: OUTPUT_INTEGRITY_GUARD_PROMPT }, ...working];
    }

    const merged: Array<{ role: NormalizedMessage['role']; text: string }> = [];
    for (const m of working) {
      if (merged.length > 0 && merged[merged.length - 1].role === m.role) {
        merged[merged.length - 1].text += `\n\n${m.content}`;
      } else {
        merged.push({ role: m.role, text: m.content });
      }
    }

    const parts: string[] = [BEGIN_SENTENCE_MARKER];
    let lastRole: NormalizedMessage['role'] | '' = '';
    for (const m of merged) {
      lastRole = m.role;
      const safeText = PromptDelimiterSanitizer.sanitizeMessageText(m.text, m.role);
      const chunk = match(m.role)
        .with(MessageRole.ASSISTANT, () => `${ASSISTANT_MARKER}${safeText}${END_SENTENCE_MARKER}`)
        .with(MessageRole.TOOL, () =>
          safeText.trim() ? `${TOOL_MARKER}${safeText}${END_TOOL_RESULTS_MARKER}` : '',
        )
        .with(MessageRole.SYSTEM, () =>
          safeText.trim() ? `${SYSTEM_MARKER}${safeText.trim()}${END_INSTRUCTIONS_MARKER}` : '',
        )
        .with(MessageRole.USER, () => `${USER_MARKER}${safeText}`)
        .exhaustive();
      if (chunk) {
        parts.push(chunk);
      }
    }
    if (lastRole !== 'assistant') {
      parts.push(ASSISTANT_MARKER);
    }
    const prompt = parts.join('').replace(/!\[(.*?)\]\((.*?)\)/g, '[$1]($2)');
    return { prompt, toolNames };
  }
}

export function messagesPrepare(
  messages: ReadonlyArray<{ role: string; content: string }>,
): string {
  const normalized: NormalizedMessage[] = messages.map((m) => ({
    role: match(m.role.toLowerCase())
      .with(MessageRole.SYSTEM, () => MessageRole.SYSTEM)
      .with(MessageRole.ASSISTANT, () => MessageRole.ASSISTANT)
      .with(MessageRole.TOOL, () => MessageRole.TOOL)
      .otherwise(() => MessageRole.USER),
    content: m.content,
  }));
  return new DeepSeekPromptBuilder().withMessages(normalized).build().prompt;
}

export function collectRefFileIds(req: StandardRequestInput & JsonObject): string[] {
  const seen = new Set<string>();
  const addId = (id: JsonValue | undefined) => {
    if (typeof id === 'string' && id.trim()) {
      seen.add(id.trim());
    }
  };
  if (Array.isArray(req.ref_file_ids)) {
    req.ref_file_ids.forEach(addId);
  }
  if (Array.isArray(req.file_ids)) {
    req.file_ids.forEach(addId);
  }
  const scanItems = (
    items: JsonValue | ReadonlyArray<PromptMessageLike | JsonObject | string> | undefined,
  ) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const obj = item as JsonObject;
      addId(obj.file_id);
      if (isJsonObject(obj.file)) {
        addId(obj.file.file_id);
        addId(obj.file.id);
      }
      if (isJsonArray(obj.content)) {
        scanItems(obj.content);
      }
    }
  };
  scanItems(req.messages as ReadonlyArray<PromptMessageLike | JsonObject>);
  scanItems(req.input);
  return Array.from(seen);
}

function resolveThinkingEnabled(
  req: StandardRequestInput & JsonObject,
  defaultThinking: boolean,
): boolean {
  if (typeof req.thinking_enabled === 'boolean') return req.thinking_enabled;
  if (isJsonObject(req.thinking)) {
    if (req.thinking.type === 'enabled') return true;
    if (req.thinking.type === 'disabled') return false;
  }
  if (typeof req.reasoning_effort === 'string') {
    return match(req.reasoning_effort.trim().toLowerCase())
      .with(P.union('none', 'disabled'), () => false)
      .with(P.union('low', 'medium', 'high'), () => true)
      .otherwise(() => defaultThinking);
  }
  if (isJsonObject(req.reasoning) && typeof req.reasoning.effort === 'string') {
    return match(req.reasoning.effort.trim().toLowerCase())
      .with(P.union('none', 'disabled'), () => false)
      .otherwise(() => true);
  }
  return defaultThinking;
}

function resolveFunctionCallId(obj: JsonObject): string {
  if (typeof obj.call_id === 'string' && obj.call_id) {
    return obj.call_id;
  }
  if (typeof obj.id === 'string' && obj.id) {
    return obj.id;
  }
  return 'call_1';
}

export function responsesMessagesFromRequest(
  req: StandardRequestInput & JsonObject,
): Array<PromptMessageLike | JsonObject> {
  const out: Array<PromptMessageLike | JsonObject> = [];
  if (typeof req.instructions === 'string' && req.instructions.trim()) {
    out.push({ role: MessageRole.SYSTEM, content: req.instructions.trim() });
  }
  if (Array.isArray(req.messages) && req.messages.length > 0) {
    out.push(...req.messages);
    return out;
  }
  const input = req.input;
  if (typeof input === 'string' && input.trim()) {
    out.push({ role: MessageRole.USER, content: input });
    return out;
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        out.push({ role: MessageRole.USER, content: item });
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const obj = item as JsonObject;
      const itemType = typeof obj.type === 'string' ? obj.type.trim().toLowerCase() : '';
      match(itemType)
        .with('function_call_output', () => {
          out.push({
            role: MessageRole.TOOL,
            content: typeof obj.output === 'string' ? obj.output : JSON.stringify(obj.output ?? ''),
          });
        })
        .with('function_call', () => {
          out.push({
            role: MessageRole.ASSISTANT,
            content: '',
            tool_calls: [
              {
                id: resolveFunctionCallId(obj),
                type: MessageRole.FUNCTION,
                function: {
                  name: typeof obj.name === 'string' ? obj.name : '',
                  arguments:
                    typeof obj.arguments === 'string'
                      ? obj.arguments
                      : JSON.stringify(obj.arguments ?? {}),
                },
              },
            ],
          });
        })
        .otherwise(() => {
          out.push({
            role: typeof obj.role === 'string' ? obj.role : MessageRole.USER,
            content: obj.content ?? obj.text ?? '',
          });
        });
    }
  }
  return out;
}

export function normalizeOpenAIRequest(
  req: StandardRequestInput & JsonObject,
  surface: RequestSurface = RequestSurfaceConst.OPENAI_CHAT,
  customAliases?: Record<string, string>,
): NormalizedStandardRequest {
  const requestedModel = typeof req.model === 'string' ? req.model.trim() : 'deepseek-chat';
  const { resolved: resolvedModel } = resolveModel(requestedModel, customAliases);
  const { thinking: defaultThinking, search: defaultSearch } = getModelConfig(resolvedModel);

  let thinking = resolveThinkingEnabled(req, defaultThinking);
  if (isNoThinkingModel(resolvedModel)) {
    thinking = false;
  }
  const search = typeof req.search_enabled === 'boolean' ? req.search_enabled : defaultSearch;

  const rawMessages: Array<PromptMessageLike | JsonObject> = match(surface)
    .with(RequestSurfaceConst.OPENAI_RESPONSES, () => responsesMessagesFromRequest(req))
    .with(RequestSurfaceConst.OPENAI_COMPLETIONS, () => {
      const promptVal = req.prompt;
      const text = Array.isArray(promptVal) ? promptVal.join('\n') : String(promptVal ?? '');
      return [{ role: MessageRole.USER, content: text }];
    })
    .with(RequestSurfaceConst.OPENAI_CHAT, () =>
      Array.isArray(req.messages) ? [...req.messages] : [],
    )
    .exhaustive();

  const toolPolicy = parseToolChoicePolicy(
    req.tool_choice as string | JsonObject | null | undefined,
    req.tools,
  );
  const normalizedMsgs = normalizeOpenAIMessagesForPrompt(rawMessages);
  const textFormat =
    isJsonObject(req.text) && isJsonObject(req.text.format) ? req.text.format : undefined;
  const responseFormat = isJsonObject(req.response_format) ? req.response_format : textFormat;

  const { prompt: finalPrompt, toolNames } = new DeepSeekPromptBuilder()
    .withMessages(normalizedMsgs)
    .withResponseFormat(responseFormat)
    .withTools(req.tools, toolPolicy)
    .build();

  const passThrough: JsonObject = {};
  for (const k of [
    'temperature',
    'top_p',
    'max_tokens',
    'max_completion_tokens',
    'presence_penalty',
    'frequency_penalty',
    'stop',
  ] as const) {
    if (k in req && req[k] !== undefined) {
      passThrough[k] = req[k] as JsonValue;
    }
  }

  return {
    surface,
    requestedModel,
    resolvedModel,
    responseModel: requestedModel || resolvedModel,
    messages: rawMessages,
    toolsRaw: req.tools,
    finalPrompt,
    toolNames,
    toolChoice: toolPolicy,
    stream: Boolean(req.stream),
    thinking,
    search,
    refFileIds: collectRefFileIds(req),
    passThrough,
  };
}

/**
 * Builder Pattern for constructing DeepSeek `/api/v0/chat/completion` request payload.
 */
export class CompletionPayloadBuilder {
  private sessionId = '';
  private modelType: DeepSeekModelType = ModelTypeConst.DEFAULT;
  private parentMessageId: string | null = null;
  private prompt = '';
  private refFileIds: string[] = [];
  private thinkingEnabled = false;
  private searchEnabled = false;
  private passThrough: JsonObject = {};

  public withSessionId(sessionId: string): this {
    this.sessionId = sessionId;
    return this;
  }

  public withModelType(modelType: DeepSeekModelType): this {
    this.modelType = modelType;
    return this;
  }

  public withParentMessageId(parentMessageId: string | null): this {
    this.parentMessageId = parentMessageId;
    return this;
  }

  public withPrompt(prompt: string): this {
    this.prompt = prompt;
    return this;
  }

  public withRefFileIds(ids: string[]): this {
    this.refFileIds = ids.filter(Boolean);
    return this;
  }

  public withThinking(enabled: boolean): this {
    this.thinkingEnabled = enabled;
    return this;
  }

  public withSearch(enabled: boolean): this {
    this.searchEnabled = enabled;
    return this;
  }

  public withPassThrough(passThrough: JsonObject): this {
    this.passThrough = { ...passThrough };
    return this;
  }

  public build(): JsonObject {
    const refArray: JsonArray = [...this.refFileIds];
    return {
      ...this.passThrough,
      chat_session_id: this.sessionId,
      model_type: this.modelType,
      parent_message_id: this.parentMessageId,
      prompt: this.prompt,
      ref_file_ids: refArray,
      thinking_enabled: this.thinkingEnabled,
      search_enabled: this.searchEnabled,
    };
  }
}

export function buildCompletionPayload(
  stdReq: NormalizedStandardRequest,
  sessionId: string,
): JsonObject {
  const modelType = getModelType(stdReq.resolvedModel || stdReq.requestedModel);
  return new CompletionPayloadBuilder()
    .withSessionId(sessionId)
    .withModelType(modelType)
    .withPrompt(stdReq.finalPrompt)
    .withRefFileIds(stdReq.refFileIds)
    .withThinking(stdReq.thinking)
    .withSearch(stdReq.search)
    .withPassThrough(stdReq.passThrough)
    .build();
}
