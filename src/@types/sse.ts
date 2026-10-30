/**
 * Server-Sent Events (SSE) Parser & Token Usage Type Definitions.
 */

export type FragmentCategory = 'thinking' | 'text';

export interface ParsedPart {
  text: string;
  type: FragmentCategory;
}

export interface ParsedChunkResult {
  parsed: boolean;
  parts: ParsedPart[];
  finished: boolean;
  contentFilter: boolean;
  errorMessage: string;
  promptTokens: number;
  outputTokens: number;
  newType: FragmentCategory;
  responseMessageId?: string;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details: {
    reasoning_tokens: number;
  };
}
