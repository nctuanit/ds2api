/**
 * DeepSeek Web API Client Type Definitions.
 */

import type { JsonObject } from './json.js';
import type { AccountPool } from '../auth/account-pool.js';

export interface UploadFileInput {
  filename: string;
  contentType?: string;
  purpose?: string;
  modelType?: string;
  data: Uint8Array | ArrayBuffer | Blob | string;
}

export interface UploadFileResult {
  id: string;
  filename: string;
  bytes: number;
  status: string;
  purpose: string;
  isImage: boolean;
  accountId: string;
  raw?: JsonObject;
}

export interface SessionInfo {
  id: string;
  title: string;
  titleType: string;
  pinned: boolean;
  updatedAt: number;
}

export interface DeepSeekClientOptions {
  baseURL?: string;
  fetch?: typeof globalThis.fetch;
  maxRetries?: number;
  defaultHeaders?: Record<string, string>;
  pool: AccountPool;
}

export interface ParsedApiResult {
  status: number;
  code: number;
  bizCode: number;
  msg: string;
  bizMsg: string;
  bizData: JsonObject;
  raw: JsonObject;
  isOk: boolean;
}
