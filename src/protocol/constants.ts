/**
 * DeepSeek protocol constants, endpoints, headers, and OOP Model Registry.
 *
 * Design Patterns Applied:
 * - Singleton & Repository Pattern (`DeepSeekModelRegistry`)
 * - Factory Method Pattern (`ModelObjectFactory`)
 * - Adapter Pattern (`ServerModelConfigAdapter`)
 * - Strategy / Chain of Responsibility Pattern (`ModelAliasResolver`)
 */

import { match } from 'ts-pattern';
import { JsonArray, JsonCodec, JsonGuard, JsonObject } from '../types/json.js';
import type {
  DeepSeekModelType,
  FetchServerModelsOptions,
  ModelCapabilityEntry,
  ModelObject,
  ServerModelConfig,
  ServerModelFileFeature,
} from '../@types/protocol.js';

export type {
  DeepSeekModelType,
  FetchServerModelsOptions,
  ModelCapabilityEntry,
  ModelObject,
  ServerModelConfig,
  ServerModelFileFeature,
};

// ─── Centralized Protocol & Domain Constants (Zero Magic Strings) ────────────

export const HttpMethod = Object.freeze({
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  PATCH: 'PATCH',
  DELETE: 'DELETE',
  OPTIONS: 'OPTIONS',
} as const);

export const HttpHeader = Object.freeze({
  HOST: 'Host',
  ACCEPT: 'Accept',
  CONTENT_TYPE: 'Content-Type',
  CONTENT_TYPE_LOWER: 'content-type',
  ACCEPT_CHARSET: 'accept-charset',
  USER_AGENT: 'User-Agent',
  AUTHORIZATION: 'Authorization',
  AUTHORIZATION_LOWER: 'authorization',
  BEARER_PREFIX: 'Bearer ',
  CLIENT_PLATFORM: 'x-client-platform',
  CLIENT_VERSION: 'x-client-version',
  CLIENT_LOCALE: 'x-client-locale',
  DEVICE_ID: 'x-device-id',
  DEVICE_MODEL: 'x-device-model',
  POW_RESPONSE: 'x-ds-pow-response',
  THINKING_ENABLED: 'x-thinking-enabled',
} as const);

export const MimeType = Object.freeze({
  JSON: 'application/json',
  JSON_UTF8: 'application/json; charset=utf-8',
  SSE_UTF8: 'text/event-stream; charset=utf-8',
  MULTIPART_FORM: 'multipart/form-data',
  OCTET_STREAM: 'application/octet-stream',
} as const);

export const ModelTypeConst = Object.freeze({
  DEFAULT: 'default',
  EXPERT: 'expert',
  VISION: 'vision',
} as const);

export const FragmentTypeConst = Object.freeze({
  THINKING: 'thinking',
  TEXT: 'text',
  RAW_THINK: 'THINK',
  RAW_THINKING: 'THINKING',
  RAW_RESPONSE: 'RESPONSE',
} as const);

export const SSEPath = Object.freeze({
  STATUS: 'status',
  RESPONSE: 'response',
  RESPONSE_STATUS: 'response/status',
  RESPONSE_FRAGMENTS: 'response/fragments',
  RESPONSE_CONTENT: 'response/content',
  RESPONSE_THINKING_CONTENT: 'response/thinking_content',
  FRAGMENTS: 'fragments',
} as const);

export const SSEConst = Object.freeze({
  OP_APPEND: 'APPEND',
  STATUS_FINISHED: 'FINISHED',
  CONTENT_FILTER: 'content_filter',
  CONTENT_FILTER_UPPER: 'CONTENT_FILTER',
  DATA_PREFIX: 'data:',
  DONE_MARKER: '[DONE]',
} as const);

export const MessageRole = Object.freeze({
  SYSTEM: 'system',
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL: 'tool',
  DEVELOPER: 'developer',
  FUNCTION: 'function',
} as const);

export const OpenAIObjectType = Object.freeze({
  MODEL: 'model',
  LIST: 'list',
  CHAT_COMPLETION: 'chat.completion',
  CHAT_COMPLETION_CHUNK: 'chat.completion.chunk',
  CHAT_COMPLETION_DELETED: 'chat.completion.deleted',
  TEXT_COMPLETION: 'text_completion',
  RESPONSE: 'response',
  RESPONSE_DELETED: 'response.deleted',
  FILE: 'file',
} as const);

export const FinishReasonConst = Object.freeze({
  STOP: 'stop',
  TOOL_CALLS: 'tool_calls',
  CONTENT_FILTER: 'content_filter',
  LENGTH: 'length',
} as const);

export const RequestSurfaceConst = Object.freeze({
  OPENAI_CHAT: 'openai_chat',
  OPENAI_RESPONSES: 'openai_responses',
  OPENAI_COMPLETIONS: 'openai_completions',
} as const);

export const SessionCleanupMode = Object.freeze({
  NONE: 'none',
  SINGLE: 'single',
  ALL: 'all',
} as const);

export const PowAlgorithm = Object.freeze({
  DEEPSEEK_HASH_V1: 'DeepSeekHashV1',
} as const);

export const DefaultTokenCache = Object.freeze({
  FILENAME: '.deepseek-tokens.json',
} as const);

export const DEEPSEEK_HOST = 'chat.deepseek.com';
export const DEEPSEEK_BASE_URL = `https://${DEEPSEEK_HOST}`;
export const DEEPSEEK_LOGIN_URL = `${DEEPSEEK_BASE_URL}/api/v0/users/login`;
export const DEEPSEEK_CLIENT_SETTINGS_URL = `${DEEPSEEK_BASE_URL}/api/v0/client/settings`;
export const DEEPSEEK_CREATE_SESSION_URL = `${DEEPSEEK_BASE_URL}/api/v0/chat_session/create`;
export const DEEPSEEK_CREATE_POW_URL = `${DEEPSEEK_BASE_URL}/api/v0/chat/create_pow_challenge`;
export const DEEPSEEK_COMPLETION_URL = `${DEEPSEEK_BASE_URL}/api/v0/chat/completion`;
export const DEEPSEEK_CONTINUE_URL = `${DEEPSEEK_BASE_URL}/api/v0/chat/continue`;
export const DEEPSEEK_UPLOAD_FILE_URL = `${DEEPSEEK_BASE_URL}/api/v0/file/upload_file`;
export const DEEPSEEK_FETCH_FILES_URL = `${DEEPSEEK_BASE_URL}/api/v0/file/fetch_files`;
export const DEEPSEEK_FETCH_SESSION_URL = `${DEEPSEEK_BASE_URL}/api/v0/chat_session/fetch_page`;
export const DEEPSEEK_DELETE_SESSION_URL = `${DEEPSEEK_BASE_URL}/api/v0/chat_session/delete`;
export const DEEPSEEK_DELETE_ALL_SESSIONS_URL = `${DEEPSEEK_BASE_URL}/api/v0/chat_session/delete_all`;

export const DEEPSEEK_COMPLETION_TARGET_PATH = '/api/v0/chat/completion';
export const DEEPSEEK_CONTINUE_TARGET_PATH = '/api/v0/chat/continue';
export const DEEPSEEK_UPLOAD_TARGET_PATH = '/api/v0/file/upload_file';
export const DEFAULT_DEVICE_UUID = 'c4f2b64b-99ca-4380-8396-c947d006d283';

export const CLIENT_INFO = Object.freeze({
  name: 'DeepSeek',
  platform: 'android',
  version: '2.0.4',
  androidApiLevel: '35',
  locale: 'zh_CN',
});

export const BASE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  [HttpHeader.HOST]: DEEPSEEK_HOST,
  [HttpHeader.ACCEPT]: MimeType.JSON,
  [HttpHeader.CONTENT_TYPE]: MimeType.JSON,
  [HttpHeader.ACCEPT_CHARSET]: 'UTF-8',
  [HttpHeader.USER_AGENT]: `${CLIENT_INFO.name}/${CLIENT_INFO.version} Android/${CLIENT_INFO.androidApiLevel}`,
  [HttpHeader.CLIENT_PLATFORM]: CLIENT_INFO.platform,
  [HttpHeader.CLIENT_VERSION]: CLIENT_INFO.version,
  [HttpHeader.CLIENT_LOCALE]: CLIENT_INFO.locale,
});

export const SKIP_CONTAINS_PATTERNS: readonly string[] = Object.freeze([
  'quasi_status',
  'elapsed_secs',
  'token_usage',
  'pending_fragment',
  'conversation_mode',
  'fragments/-1/status',
  'fragments/-2/status',
  'fragments/-3/status',
]);

export const SKIP_EXACT_PATHS: ReadonlySet<string> = new Set(['response/search_status']);

const NO_THINKING_SUFFIX = '-nothinking';
const DEFAULT_CREATED_AT = 1677610602;

const MODEL_TYPE_TO_BASE_ID: Readonly<Record<string, string>> = Object.freeze({
  default: 'deepseek-v4-flash',
  expert: 'deepseek-v4-pro',
  vision: 'deepseek-v4-vision',
});

const SEED_SERVER_MODEL_CONFIGS: readonly ServerModelConfig[] = Object.freeze([
  {
    model_type: 'default',
    name: 'Instant',
    welcome_msg: 'Start chatting with Instant',
    is_default: true,
    enabled: true,
    switchable: true,
    input_character_limit: 2621440,
    has_think: true,
    has_search: true,
  },
  {
    model_type: 'expert',
    name: 'Expert',
    welcome_msg: 'Start chatting with Expert',
    is_default: false,
    enabled: false,
    switchable: false,
    input_character_limit: 2621440,
    has_think: true,
    has_search: true,
  },
  {
    model_type: 'vision',
    name: 'Vision',
    welcome_msg: 'Start chatting with Vision',
    is_default: false,
    enabled: false,
    switchable: false,
    input_character_limit: 2621440,
    has_think: true,
    has_search: false,
  },
]);

export const DEFAULT_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // Upstream server model_type IDs
  default: 'deepseek-v4-flash',
  expert: 'deepseek-v4-pro',
  vision: 'deepseek-v4-vision',

  // Classic DeepSeek model IDs
  'deepseek-chat': 'deepseek-v4-flash-nothinking',
  'deepseek-reasoner': 'deepseek-v4-flash',
  'deepseek-chat-search': 'deepseek-v4-flash-search-nothinking',
  'deepseek-reasoner-search': 'deepseek-v4-flash-search',
  'deepseek-r1': 'deepseek-v4-pro',
  'deepseek-v3': 'deepseek-v4-flash-nothinking',

  // OpenAI GPT / ChatGPT families
  'chatgpt-4o': 'deepseek-v4-flash',
  'gpt-3.5-turbo': 'deepseek-v4-flash-nothinking',
  'gpt-4': 'deepseek-v4-flash',
  'gpt-4-turbo': 'deepseek-v4-flash',
  'gpt-4-turbo-preview': 'deepseek-v4-flash',
  'gpt-4.5-preview': 'deepseek-v4-flash',
  'gpt-4o': 'deepseek-v4-flash',
  'gpt-4o-mini': 'deepseek-v4-flash',
  'gpt-4.1': 'deepseek-v4-flash',
  'gpt-4.1-mini': 'deepseek-v4-flash',
  'gpt-4.1-nano': 'deepseek-v4-flash',
  'gpt-5': 'deepseek-v4-flash',
  'gpt-5-chat': 'deepseek-v4-flash',
  'gpt-5.1': 'deepseek-v4-flash',
  'gpt-5.1-chat': 'deepseek-v4-flash',
  'gpt-5.2': 'deepseek-v4-flash',
  'gpt-5.2-chat': 'deepseek-v4-flash',
  'gpt-5.3-chat': 'deepseek-v4-flash',
  'gpt-5.4': 'deepseek-v4-flash',
  'gpt-5.5': 'deepseek-v4-flash',
  'gpt-5-mini': 'deepseek-v4-flash',
  'gpt-5-nano': 'deepseek-v4-flash',
  'gpt-5.4-mini': 'deepseek-v4-flash',
  'gpt-5.4-nano': 'deepseek-v4-flash',
  'gpt-5-pro': 'deepseek-v4-pro',
  'gpt-5.2-pro': 'deepseek-v4-pro',
  'gpt-5.4-pro': 'deepseek-v4-pro',
  'gpt-5.5-pro': 'deepseek-v4-pro',
  'gpt-5-codex': 'deepseek-v4-pro',
  'gpt-5.1-codex': 'deepseek-v4-pro',
  'gpt-5.1-codex-mini': 'deepseek-v4-pro',
  'gpt-5.1-codex-max': 'deepseek-v4-pro',
  'gpt-5.2-codex': 'deepseek-v4-pro',
  'gpt-5.3-codex': 'deepseek-v4-pro',
  'codex-mini-latest': 'deepseek-v4-pro',

  // OpenAI reasoning / research families
  o1: 'deepseek-v4-pro',
  'o1-preview': 'deepseek-v4-pro',
  'o1-mini': 'deepseek-v4-pro',
  'o1-pro': 'deepseek-v4-pro',
  o3: 'deepseek-v4-pro',
  'o3-mini': 'deepseek-v4-pro',
  'o3-pro': 'deepseek-v4-pro',
  'o3-deep-research': 'deepseek-v4-pro-search',
  'o4-mini': 'deepseek-v4-pro',
  'o4-mini-deep-research': 'deepseek-v4-pro-search',

  // Claude aliases
  'claude-opus-4-6': 'deepseek-v4-pro',
  'claude-opus-4-1': 'deepseek-v4-pro',
  'claude-opus-4-1-20250805': 'deepseek-v4-pro',
  'claude-opus-4-0': 'deepseek-v4-pro',
  'claude-opus-4-20250514': 'deepseek-v4-pro',
  'claude-sonnet-4-6': 'deepseek-v4-flash',
  'claude-sonnet-4-5': 'deepseek-v4-flash',
  'claude-sonnet-4-5-20250929': 'deepseek-v4-flash',
  'claude-sonnet-4-0': 'deepseek-v4-flash',
  'claude-sonnet-4-20250514': 'deepseek-v4-flash',
  'claude-haiku-4-5': 'deepseek-v4-flash',
  'claude-haiku-4-5-20251001': 'deepseek-v4-flash',
  'claude-3-7-sonnet': 'deepseek-v4-flash',
  'claude-3-7-sonnet-latest': 'deepseek-v4-flash',
  'claude-3-5-sonnet': 'deepseek-v4-flash',
  'claude-3-5-sonnet-latest': 'deepseek-v4-flash',
  'claude-3-5-haiku': 'deepseek-v4-flash',
  'claude-3-5-haiku-latest': 'deepseek-v4-flash',
  'claude-3-opus': 'deepseek-v4-pro',

  // Gemini aliases
  'gemini-pro': 'deepseek-v4-pro',
  'gemini-pro-vision': 'deepseek-v4-vision',
  'gemini-1.5-pro': 'deepseek-v4-pro',
  'gemini-1.5-flash': 'deepseek-v4-flash',
  'gemini-2.0-flash': 'deepseek-v4-flash',
  'gemini-2.5-pro': 'deepseek-v4-pro',
  'gemini-2.5-flash': 'deepseek-v4-flash',
  'gemini-3-pro': 'deepseek-v4-pro',
  'gemini-3-flash': 'deepseek-v4-flash',
  'gemini-3.1-pro': 'deepseek-v4-pro',
  'gemini-3.1-flash': 'deepseek-v4-flash',
});

// ─── Adapter Pattern: ServerModelConfigAdapter ───────────────────────────────

/**
 * Adapter Pattern: Converts raw `/api/v0/client/settings?scope=model` JSON envelopes
 * into strongly-typed `ServerModelConfig[]` domain objects.
 */
export class ServerModelConfigAdapter {
  private static extractRawConfigArray(
    modelConfigsNode: JsonObject,
    bizData: JsonObject,
  ): JsonArray {
    if (JsonGuard.isArray(modelConfigsNode.value)) {
      return modelConfigsNode.value;
    }
    if (JsonGuard.isArray(bizData.model_configs)) {
      return bizData.model_configs;
    }
    return [];
  }

  public static fromEnvelope(payload: JsonObject | null): ServerModelConfig[] {
    if (!payload) return [];
    const data = JsonGuard.isObject(payload.data) ? payload.data : payload;
    const bizData = JsonGuard.isObject(data.biz_data) ? data.biz_data : data;
    const settings = JsonGuard.isObject(bizData.settings) ? bizData.settings : bizData;
    const modelConfigsNode = JsonGuard.isObject(settings.model_configs)
      ? settings.model_configs
      : settings;
    const rawList = ServerModelConfigAdapter.extractRawConfigArray(modelConfigsNode, bizData);

    const configs: ServerModelConfig[] = [];
    for (const item of rawList) {
      if (!JsonGuard.isObject(item)) continue;
      const parsed = ServerModelConfigAdapter.fromItem(item);
      if (parsed) {
        configs.push(parsed);
      }
    }
    return configs;
  }

  public static fromItem(item: JsonObject): ServerModelConfig | null {
    const modelType = JsonCodec.asCleanString(item.model_type);
    if (!modelType) return null;

    const ff = JsonGuard.isObject(item.file_feature) ? item.file_feature : undefined;
    const fileFeature: ServerModelFileFeature | undefined = ff
      ? {
          ...(typeof ff.token_limit === 'number' ? { token_limit: ff.token_limit } : {}),
          ...(typeof ff.token_limit_with_thinking === 'number'
            ? { token_limit_with_thinking: ff.token_limit_with_thinking }
            : {}),
          ...(typeof ff.max_input_file_count === 'number'
            ? { max_input_file_count: ff.max_input_file_count }
            : {}),
          ...(typeof ff.max_upload_file_size === 'number'
            ? { max_upload_file_size: ff.max_upload_file_size }
            : {}),
          ...(typeof ff.conflict_with_search === 'boolean'
            ? { conflict_with_search: ff.conflict_with_search }
            : {}),
          ...(typeof ff.vision === 'boolean' ? { vision: ff.vision } : {}),
          ...(typeof ff.enable_thumbnail === 'boolean'
            ? { enable_thumbnail: ff.enable_thumbnail }
            : {}),
        }
      : undefined;

    return {
      model_type: modelType,
      name: JsonCodec.asCleanString(item.name) || modelType,
      description: JsonCodec.asCleanString(item.description),
      welcome_msg: JsonCodec.asCleanString(item.welcome_msg),
      is_default: typeof item.is_default === 'boolean' ? item.is_default : undefined,
      enabled: typeof item.enabled === 'boolean' ? item.enabled : undefined,
      switchable: typeof item.switchable === 'boolean' ? item.switchable : undefined,
      input_character_limit:
        typeof item.input_character_limit === 'number'
          ? JsonCodec.asNumberOr(item.input_character_limit, 0)
          : undefined,
      has_think: JsonGuard.isObject(item.think_feature),
      has_search: JsonGuard.isObject(item.search_feature),
      ...(fileFeature ? { file_feature: fileFeature } : {}),
    };
  }
}

// ─── Factory Method Pattern: ModelObjectFactory ──────────────────────────────

/**
 * Factory Method Pattern: Constructs OpenAI-compatible `ModelObject` instances
 * and capability maps from upstream `ServerModelConfig` descriptors.
 */
export class ModelObjectFactory {
  public static createEntry(
    id: string,
    cfg: ServerModelConfig,
    thinking: boolean,
    search: boolean,
  ): ModelObject {
    return {
      id,
      object: OpenAIObjectType.MODEL,
      created: DEFAULT_CREATED_AT,
      owned_by: 'deepseek',
      permission: [],
      model_type: cfg.model_type,
      name: cfg.name,
      ...(cfg.description ? { description: cfg.description } : {}),
      ...(cfg.welcome_msg ? { welcome_msg: cfg.welcome_msg } : {}),
      ...(cfg.enabled !== undefined ? { enabled: cfg.enabled } : {}),
      ...(cfg.is_default !== undefined ? { is_default: cfg.is_default } : {}),
      ...(cfg.switchable !== undefined ? { switchable: cfg.switchable } : {}),
      ...(cfg.input_character_limit !== undefined
        ? { input_character_limit: cfg.input_character_limit }
        : {}),
      thinking,
      search,
      ...(cfg.file_feature ? { file_feature: cfg.file_feature } : {}),
    };
  }

  public static normalizeModelType(rawType: string): DeepSeekModelType {
    return match(rawType)
      .with(ModelTypeConst.EXPERT, () => ModelTypeConst.EXPERT)
      .with(ModelTypeConst.VISION, () => ModelTypeConst.VISION)
      .otherwise(() => ModelTypeConst.DEFAULT);
  }

  public static buildCatalog(
    configs: ReadonlyArray<ServerModelConfig>,
    capabilitiesOut?: Map<string, ModelCapabilityEntry>,
  ): ModelObject[] {
    const source = configs.length > 0 ? configs : SEED_SERVER_MODEL_CONFIGS;
    const out: ModelObject[] = [];
    const seen = new Set<string>();

    const pushUnique = (item: ModelObject) => {
      if (seen.has(item.id)) return;
      seen.add(item.id);
      out.push(item);
    };

    for (const cfg of source) {
      const rawType = cfg.model_type.trim().toLowerCase();
      if (!rawType) continue;

      const normalizedType = ModelObjectFactory.normalizeModelType(rawType);
      const mappedBaseId = JsonGuard.hasOwn(MODEL_TYPE_TO_BASE_ID, rawType)
        ? MODEL_TYPE_TO_BASE_ID[rawType]
        : undefined;
      const fallbackBaseId = rawType.startsWith('deepseek-') ? rawType : `deepseek-${rawType}`;
      const baseId = mappedBaseId ?? fallbackBaseId;
      const hasThink = cfg.has_think !== false;
      const hasSearch = Boolean(cfg.has_search);

      capabilitiesOut?.set(baseId, {
        modelType: normalizedType,
        thinking: hasThink,
        search: false,
      });
      pushUnique(ModelObjectFactory.createEntry(baseId, cfg, hasThink, false));
      if (hasThink) {
        pushUnique(
          ModelObjectFactory.createEntry(`${baseId}${NO_THINKING_SUFFIX}`, cfg, false, false),
        );
      }

      if (hasSearch) {
        const searchId = `${baseId}-search`;
        capabilitiesOut?.set(searchId, {
          modelType: normalizedType,
          thinking: hasThink,
          search: true,
        });
        pushUnique(ModelObjectFactory.createEntry(searchId, cfg, hasThink, true));
        if (hasThink) {
          pushUnique(
            ModelObjectFactory.createEntry(`${searchId}${NO_THINKING_SUFFIX}`, cfg, false, true),
          );
        }
      }

      if (rawType === ModelTypeConst.DEFAULT) {
        pushUnique(ModelObjectFactory.createEntry('deepseek-chat', cfg, false, false));
        if (hasThink) {
          pushUnique(ModelObjectFactory.createEntry('deepseek-reasoner', cfg, true, false));
        }
        if (hasSearch) {
          pushUnique(ModelObjectFactory.createEntry('deepseek-chat-search', cfg, false, true));
          if (hasThink) {
            pushUnique(ModelObjectFactory.createEntry('deepseek-reasoner-search', cfg, true, true));
          }
        }
      }
    }

    return out;
  }
}

// ─── Strategy / Chain of Responsibility Pattern: ModelAliasResolver ──────────

/**
 * Strategy / Chain of Responsibility Pattern: Resolves user-provided model names
 * (OpenAI, Claude, Gemini, or DeepSeek aliases) into canonical DeepSeek model IDs.
 */
export class ModelAliasResolver {
  public static splitNoThinking(model: string): { baseModel: string; noThinking: boolean } {
    const lower = model.trim().toLowerCase();
    if (lower.endsWith(NO_THINKING_SUFFIX)) {
      return {
        baseModel: lower.slice(0, -NO_THINKING_SUFFIX.length),
        noThinking: true,
      };
    }
    return { baseModel: lower, noThinking: false };
  }

  public static resolve(
    requested: string,
    isSupported: (modelId: string) => boolean,
    customAliases?: Record<string, string>,
  ): { resolved: string; ok: boolean } {
    const model = requested.trim().toLowerCase();
    if (!model) {
      return { resolved: '', ok: false };
    }
    if (isSupported(model)) {
      return { resolved: model, ok: true };
    }

    let aliases: Readonly<Record<string, string>> = DEFAULT_MODEL_ALIASES;
    if (customAliases) {
      const merged: Record<string, string> = { ...DEFAULT_MODEL_ALIASES };
      for (const [k, v] of Object.entries(customAliases)) {
        const cleanKey = k.trim().toLowerCase();
        if (JsonGuard.isSafeKey(cleanKey) && typeof v === 'string') {
          merged[cleanKey] = v.trim().toLowerCase();
        }
      }
      aliases = merged;
    }

    const directMapped = JsonGuard.hasOwn(aliases, model) ? aliases[model] : undefined;
    if (typeof directMapped === 'string' && directMapped && isSupported(directMapped)) {
      return { resolved: directMapped, ok: true };
    }

    const { baseModel, noThinking } = ModelAliasResolver.splitNoThinking(model);
    const baseMapped = JsonGuard.hasOwn(aliases, baseModel) ? aliases[baseModel] : undefined;
    if (typeof baseMapped === 'string' && baseMapped && isSupported(baseMapped)) {
      const { baseModel: canonicalBase } = ModelAliasResolver.splitNoThinking(baseMapped);
      return {
        resolved: noThinking ? `${canonicalBase}${NO_THINKING_SUFFIX}` : canonicalBase,
        ok: true,
      };
    }
    return { resolved: 'deepseek-v4-flash', ok: false };
  }
}

// ─── Singleton & Repository Pattern: DeepSeekModelRegistry ───────────────────

/**
 * Singleton & Repository Pattern: Central OOP registry that fetches, caches,
 * and resolves DeepSeek server models and capabilities.
 */
export class DeepSeekModelRegistry {
  private static instance: DeepSeekModelRegistry | null = null;

  public readonly serverConfigs: ServerModelConfig[];
  public readonly models: ModelObject[];
  private readonly capabilities = new Map<string, ModelCapabilityEntry>();

  public constructor(seedConfigs: ReadonlyArray<ServerModelConfig> = SEED_SERVER_MODEL_CONFIGS) {
    this.serverConfigs = [...seedConfigs];
    this.models = ModelObjectFactory.buildCatalog(this.serverConfigs, this.capabilities);
  }

  public static getInstance(): DeepSeekModelRegistry {
    if (!DeepSeekModelRegistry.instance) {
      DeepSeekModelRegistry.instance = new DeepSeekModelRegistry();
    }
    return DeepSeekModelRegistry.instance;
  }

  public getServerConfigs(): ServerModelConfig[] {
    return this.serverConfigs;
  }

  public getModels(): ModelObject[] {
    return this.models;
  }

  public syncFromConfigs(configs: ReadonlyArray<ServerModelConfig>): ModelObject[] {
    if (configs.length === 0) {
      return this.models;
    }
    this.serverConfigs.splice(0, this.serverConfigs.length, ...configs);
    const nextModels = ModelObjectFactory.buildCatalog(configs, this.capabilities);
    this.models.splice(0, this.models.length, ...nextModels);
    return this.models;
  }

  public async fetchConfigsFromServer(
    options: FetchServerModelsOptions = {},
  ): Promise<ServerModelConfig[]> {
    const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    const base = (options.baseURL ?? DEEPSEEK_BASE_URL).replace(/\/+$/, '');
    const did = options.deviceId ?? DEFAULT_DEVICE_UUID;
    const url = `${base}/api/v0/client/settings?did=${encodeURIComponent(did)}&scope=model`;

    const headers: Record<string, string> = {
      ...BASE_HEADERS,
      [HttpHeader.CLIENT_LOCALE]: options.locale ?? 'en_US',
      [HttpHeader.DEVICE_ID]: did,
      [HttpHeader.DEVICE_MODEL]: '',
    };
    if (options.token && options.token.trim()) {
      headers[HttpHeader.AUTHORIZATION] = `${HttpHeader.BEARER_PREFIX}${options.token.trim()}`;
    }

    try {
      const res = await fetchFn(url, {
        method: HttpMethod.GET,
        headers,
        signal: options.signal ?? undefined,
      });
      const text = await res.text();
      const parsed = JsonCodec.parseObject(text);
      const configs = ServerModelConfigAdapter.fromEnvelope(parsed);
      if (configs.length > 0) {
        this.syncFromConfigs(configs);
        return configs;
      }
    } catch {
      // Fallback to cached serverConfigs when offline
    }
    return [...this.serverConfigs];
  }

  public async fetchModelsFromServer(
    options: FetchServerModelsOptions = {},
  ): Promise<ModelObject[]> {
    const configs = await this.fetchConfigsFromServer(options);
    return this.syncFromConfigs(configs);
  }

  public getModelConfig(model: string): { thinking: boolean; search: boolean; ok: boolean } {
    const { baseModel, noThinking } = ModelAliasResolver.splitNoThinking(model);
    const entry = this.capabilities.get(baseModel);
    if (entry) {
      return {
        thinking: noThinking ? false : entry.thinking,
        search: entry.search,
        ok: true,
      };
    }
    return { thinking: false, search: false, ok: false };
  }

  public getModelType(model: string): DeepSeekModelType {
    const { baseModel } = ModelAliasResolver.splitNoThinking(model);
    return this.capabilities.get(baseModel)?.modelType ?? ModelTypeConst.DEFAULT;
  }

  public isSupportedModel(model: string): boolean {
    return this.getModelConfig(model).ok;
  }

  public resolveModel(
    requested: string,
    customAliases?: Record<string, string>,
  ): { resolved: string; ok: boolean } {
    return ModelAliasResolver.resolve(requested, (id) => this.isSupportedModel(id), customAliases);
  }
}

const defaultRegistry = DeepSeekModelRegistry.getInstance();

export const SERVER_MODEL_CONFIGS: ServerModelConfig[] = defaultRegistry.serverConfigs;

export const DEEPSEEK_MODELS: ModelObject[] = defaultRegistry.models;

export function buildModelsFromServerConfigs(
  configs: ReadonlyArray<ServerModelConfig>,
): ModelObject[] {
  return ModelObjectFactory.buildCatalog(configs);
}

export function parseServerModelConfigs(payload: JsonObject | null): ServerModelConfig[] {
  return ServerModelConfigAdapter.fromEnvelope(payload);
}

export function syncServerModelConfigs(configs: ReadonlyArray<ServerModelConfig>): ModelObject[] {
  return defaultRegistry.syncFromConfigs(configs);
}

export async function fetchServerModelConfigs(
  options: FetchServerModelsOptions = {},
): Promise<ServerModelConfig[]> {
  return defaultRegistry.fetchConfigsFromServer(options);
}

export async function fetchServerModels(
  options: FetchServerModelsOptions = {},
): Promise<ModelObject[]> {
  return defaultRegistry.fetchModelsFromServer(options);
}

export function splitNoThinkingModel(model: string): { baseModel: string; noThinking: boolean } {
  return ModelAliasResolver.splitNoThinking(model);
}

export function getModelConfig(model: string): { thinking: boolean; search: boolean; ok: boolean } {
  return defaultRegistry.getModelConfig(model);
}

export function getModelType(model: string): DeepSeekModelType {
  return defaultRegistry.getModelType(model);
}

export function isSupportedDeepSeekModel(model: string): boolean {
  return defaultRegistry.isSupportedModel(model);
}

export function isNoThinkingModel(model: string): boolean {
  return ModelAliasResolver.splitNoThinking(model).noThinking;
}

export function resolveModel(
  requested: string,
  customAliases?: Record<string, string>,
): { resolved: string; ok: boolean } {
  return defaultRegistry.resolveModel(requested, customAliases);
}
