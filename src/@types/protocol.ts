/**
 * DeepSeek Protocol, Server Model Config, and Model Registry Type Definitions.
 */

import type { JsonObject } from './json.js';

export type DeepSeekModelType = 'default' | 'expert' | 'vision';

export interface ServerModelFileFeature {
  token_limit?: number;
  token_limit_with_thinking?: number;
  max_input_file_count?: number;
  max_upload_file_size?: number;
  conflict_with_search?: boolean;
  vision?: boolean;
  enable_thumbnail?: boolean;
}

export interface ServerModelConfig {
  model_type: string;
  name: string;
  description?: string;
  welcome_msg?: string;
  is_default?: boolean;
  enabled?: boolean;
  switchable?: boolean;
  input_character_limit?: number;
  has_think?: boolean;
  has_search?: boolean;
  file_feature?: ServerModelFileFeature;
}

export interface ModelObject {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  permission?: JsonObject[];
  model_type?: string;
  name?: string;
  description?: string;
  welcome_msg?: string;
  enabled?: boolean;
  is_default?: boolean;
  switchable?: boolean;
  input_character_limit?: number;
  thinking?: boolean;
  search?: boolean;
  file_feature?: ServerModelFileFeature;
}

export interface ModelCapabilityEntry {
  modelType: DeepSeekModelType;
  thinking: boolean;
  search: boolean;
}

export interface FetchServerModelsOptions {
  baseURL?: string;
  token?: string;
  deviceId?: string;
  locale?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal | null;
}
