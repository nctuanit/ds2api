/**
 * Multi-Account Pool & Token Resolver for DeepSeek Web API.
 *
 * Design Patterns applied:
 * - Strategy Pattern (`AccountSelectionStrategy`, `RoundRobinSelectionStrategy`)
 * - Exhaustive Pattern Matching via `ts-pattern`
 */

import { match, P } from 'ts-pattern';
import { JsonGuard, safeJsonParseObject, StringRecord } from '../types/json.js';
import type {
  AccountSelectionStrategy,
  DeepSeekAccount,
  LoginFn,
  NodeFsLike,
  RequestAuth,
} from '../@types/auth.js';

export type { AccountSelectionStrategy, DeepSeekAccount, LoginFn, NodeFsLike, RequestAuth };

const TOKEN_FILE_MODE_OWNER_ONLY = 0o600;

let cachedFsPromise: Promise<NodeFsLike | null> | undefined;

async function resolveNodeFs(): Promise<NodeFsLike | null> {
  if (!cachedFsPromise) {
    cachedFsPromise = (async () => {
      try {
        const fsSpecifier = 'node:fs';
        const mod = (await import(fsSpecifier)) as NodeFsLike & { default?: NodeFsLike };
        return mod.default ?? mod;
      } catch {
        return null;
      }
    })();
  }
  return cachedFsPromise;
}

function readTokenStore(fs: NodeFsLike, filePath: string): StringRecord {
  const store: StringRecord = Object.create(null) as StringRecord;
  try {
    if (!fs.existsSync(filePath)) return store;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    const parsed = raw ? safeJsonParseObject(raw) : null;
    if (parsed) {
      for (const [k, v] of Object.entries(parsed)) {
        if (JsonGuard.isSafeKey(k) && typeof v === 'string' && v.trim()) {
          store[k] = v.trim();
        }
      }
    }
  } catch {
    // Ignore file read errors
  }
  return store;
}

/**
 * Default Round-Robin selection strategy.
 */
export class RoundRobinSelectionStrategy implements AccountSelectionStrategy {
  private cursor = 0;

  public nextIndex(totalAccounts: number): number {
    if (totalAccounts <= 0) return 0;
    const idx = this.cursor % totalAccounts;
    this.cursor = (this.cursor + 1) % totalAccounts;
    return idx;
  }
}

export class AccountPool {
  private readonly accounts: DeepSeekAccount[] = [];
  private readonly selectionStrategy: AccountSelectionStrategy;
  private readonly inFlightLogins = new Map<string, Promise<string>>();
  private loginFn?: LoginFn;
  private tokenCacheFile?: string | false;

  constructor(
    accounts: DeepSeekAccount[] = [],
    loginFn?: LoginFn,
    selectionStrategy: AccountSelectionStrategy = new RoundRobinSelectionStrategy(),
    tokenCacheFile?: string | false,
  ) {
    this.accounts = accounts.map((a) => ({ ...a }));
    this.loginFn = loginFn;
    this.selectionStrategy = selectionStrategy;
    this.tokenCacheFile = tokenCacheFile;
  }

  public setTokenCacheFile(filePath: string | false | undefined): void {
    this.tokenCacheFile = filePath;
  }

  private async readCachedToken(accountId: string): Promise<string | undefined> {
    if (!this.tokenCacheFile || !JsonGuard.isSafeKey(accountId)) return undefined;
    const fs = await resolveNodeFs();
    if (!fs) return undefined;
    const store = readTokenStore(fs, this.tokenCacheFile);
    return JsonGuard.hasOwn(store, accountId) ? store[accountId] : undefined;
  }

  private async writeCachedToken(accountId: string, token: string): Promise<void> {
    if (!this.tokenCacheFile || !token || !JsonGuard.isSafeKey(accountId)) return;
    const fs = await resolveNodeFs();
    if (!fs) return;
    try {
      const store = readTokenStore(fs, this.tokenCacheFile);
      store[accountId] = token;
      fs.writeFileSync(this.tokenCacheFile, JSON.stringify(store, null, 2), {
        encoding: 'utf8',
        mode: TOKEN_FILE_MODE_OWNER_ONLY,
      });
    } catch {
      // Ignore file write errors in read-only environments
    }
  }

  private async performLoginDeduplicated(
    accountId: string,
    acc: DeepSeekAccount,
    signal?: AbortSignal | null,
  ): Promise<string> {
    if (!this.loginFn) return '';
    const existing = this.inFlightLogins.get(accountId);
    if (existing) {
      return existing;
    }
    const loginPromise = (async () => {
      try {
        const token = await this.loginFn!(acc, signal);
        if (token) {
          acc.token = token;
          await this.writeCachedToken(accountId, token);
        }
        return token;
      } finally {
        this.inFlightLogins.delete(accountId);
      }
    })();
    this.inFlightLogins.set(accountId, loginPromise);
    return loginPromise;
  }

  public setLoginFn(fn: LoginFn): void {
    this.loginFn = fn;
  }

  public addAccount(account: DeepSeekAccount): void {
    this.accounts.push({ ...account });
  }

  public getAccounts(): ReadonlyArray<DeepSeekAccount> {
    return this.accounts;
  }

  public size(): number {
    return this.accounts.length;
  }

  public static parseApiKeyInput(apiKey?: string, accounts?: DeepSeekAccount[]): DeepSeekAccount[] {
    const out: DeepSeekAccount[] = [];
    if (Array.isArray(accounts)) {
      for (const acc of accounts) {
        if (acc && typeof acc === 'object') {
          out.push({ ...acc });
        }
      }
    }
    if (typeof apiKey === 'string' && apiKey.trim()) {
      const parts = apiKey
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const part of parts) {
        const pipeIdx = part.indexOf('|');
        const colonIdx = part.indexOf(':');
        const sepIdx = pipeIdx > 0 ? pipeIdx : colonIdx;
        const isCredentialPair = sepIdx > 0 && !part.startsWith('eyJ') && !part.startsWith('sk-');

        match({ isCredentialPair, part })
          .with({ isCredentialPair: true }, ({ part: raw }) => {
            const user = raw.slice(0, sepIdx).trim();
            const password = raw.slice(sepIdx + 1).trim();
            if (user.includes('@')) {
              out.push({ id: user, email: user, password });
            } else {
              out.push({ id: user, mobile: user, password });
            }
          })
          .with({ isCredentialPair: false }, ({ part: token }) => {
            out.push({
              id: `token_${out.length + 1}`,
              token,
            });
          })
          .exhaustive();
      }
    }
    return out;
  }

  public async acquire(
    overrideToken?: string,
    signal?: AbortSignal | null,
    excludeIds?: Set<string>,
  ): Promise<RequestAuth> {
    if (overrideToken && overrideToken.trim()) {
      return {
        accountId: 'direct_override',
        token: overrideToken.trim(),
        managed: false,
      };
    }

    const total = this.accounts.length;
    if (total === 0) {
      throw new Error(
        'No DeepSeek token or account configured. Pass `apiKey` (DeepSeek token) or `accounts` in constructor.',
      );
    }

    for (let i = 0; i < total; i++) {
      const idx = this.selectionStrategy.nextIndex(total);
      const acc = this.accounts[idx];
      const id = this.identifierOf(acc, idx);
      if (excludeIds && excludeIds.has(id) && excludeIds.size < total) {
        continue;
      }

      if (!acc.token && acc.password && (acc.email || acc.mobile)) {
        const cached = await this.readCachedToken(id);
        if (cached) {
          acc.token = cached;
        } else if (this.loginFn) {
          acc.token = await this.performLoginDeduplicated(id, acc, signal);
        }
      }

      if (acc.token) {
        return {
          accountId: id,
          token: acc.token,
          account: acc,
          managed: true,
        };
      }
    }

    throw new Error('Failed to acquire a valid DeepSeek token from account pool.');
  }

  public async refreshToken(auth: RequestAuth, signal?: AbortSignal | null): Promise<boolean> {
    return match({
      managed: auth.managed,
      hasAccount: Boolean(auth.account),
      hasLoginFn: Boolean(this.loginFn),
      hasCredentials: Boolean(
        auth.account?.password && (auth.account?.email || auth.account?.mobile),
      ),
    })
      .with(
        {
          managed: true,
          hasAccount: true,
          hasLoginFn: true,
          hasCredentials: true,
        },
        async () => {
          try {
            const newToken = await this.performLoginDeduplicated(
              auth.accountId,
              auth.account!,
              signal,
            );
            if (newToken) {
              auth.account!.token = newToken;
              auth.token = newToken;
              return true;
            }
          } catch {
            // Allow fallback to account switching
          }
          return false;
        },
      )
      .with(P._, async () => false)
      .exhaustive();
  }

  public async switchAccount(
    auth: RequestAuth,
    signal?: AbortSignal | null,
    triedIds: Set<string> = new Set(),
  ): Promise<boolean> {
    if (!auth.managed || this.accounts.length <= 1) {
      return false;
    }
    triedIds.add(auth.accountId);
    try {
      const next = await this.acquire(undefined, signal, triedIds);
      auth.accountId = next.accountId;
      auth.token = next.token;
      auth.account = next.account;
      return true;
    } catch {
      return false;
    }
  }

  private identifierOf(acc: DeepSeekAccount, index: number): string {
    return acc.id || acc.email || acc.mobile || `account_${index + 1}`;
  }
}
