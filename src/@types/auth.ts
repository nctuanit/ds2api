/**
 * Authentication, Account Pool, and Token Store Type Definitions.
 */

export interface NodeFsWriteOptions {
  encoding?: string;
  mode?: number;
}

export interface NodeFsLike {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: string): string;
  writeFileSync(path: string, data: string, options?: string | NodeFsWriteOptions): void;
}

export interface DeepSeekAccount {
  id?: string;
  email?: string;
  mobile?: string;
  password?: string;
  token?: string;
}

export interface RequestAuth {
  accountId: string;
  token: string;
  account?: DeepSeekAccount;
  managed: boolean;
}

export type LoginFn = (account: DeepSeekAccount, signal?: AbortSignal | null) => Promise<string>;

/**
 * Strategy interface for picking the next account from the pool.
 */
export interface AccountSelectionStrategy {
  nextIndex(totalAccounts: number): number;
}
