import { createHash } from 'node:crypto';
import type { Memento, SecretStorage } from 'vscode';
import type { GitLabGroup, GitLabUser } from '../api/types';
import { normalizeGitLabBaseUrl } from '../api/urlPolicy';

import type { GitLabAccount } from './accountProtocol';
export type { GitLabAccount } from './accountProtocol';
export const ACCOUNTS_KEY = 'gitlabWorkspace.accounts.v1';
export const ACTIVE_ACCOUNT_KEY = 'gitlabWorkspace.activeAccountId';
export const LEGACY_TOKEN_KEY = 'gitlabWorkspace.accessToken';
const MIGRATION_KEY = 'gitlabWorkspace.accountMigration.v1';
export const accountTokenKey = (id: string): string => 'gitlabWorkspace.accountToken.' + id;
export const accountId = (baseUrl: string, userId: number): string => createHash('sha256')
  .update(normalizeGitLabBaseUrl(baseUrl) + '\0' + userId).digest('hex').slice(0, 32);

export class AccountStore {
  private initialized = false;
  private activeIdValue?: string;
  constructor(private readonly state: Memento, private readonly secrets: SecretStorage, private readonly workspace: Memento = state) {}
  get ready(): boolean { return this.initialized; }
  get activeId(): string | undefined { return this.initialized ? this.activeIdValue : this.workspace.get<string>(ACTIVE_ACCOUNT_KEY); }
  get active(): GitLabAccount | undefined { return this.list().find(account => account.id === this.activeId); }
  list(): GitLabAccount[] {
    const stored = this.state.get<unknown>(ACCOUNTS_KEY);
    if (!Array.isArray(stored)) return [];
    return stored.filter((item): item is GitLabAccount => {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[a-f0-9]{32}$/.test(item.id) ||
        typeof item.baseUrl !== 'string' || !Number.isSafeInteger(item.userId) || item.userId <= 0 ||
        typeof item.name !== 'string' || typeof item.username !== 'string' || typeof item.needsLogin !== 'boolean') return false;
      try { return item.id === accountId(item.baseUrl, item.userId); } catch { return false; }
    }).map(account => ({ ...account, group: account.group && Number.isSafeInteger(account.group.id) && account.group.id > 0 &&
      typeof account.group.fullPath === 'string' && account.group.fullPath ? { ...account.group } : undefined }));
  }

  async initialize(resolveUser: (url: string, token: string) => Promise<GitLabUser>): Promise<void> {
    if (this.initialized) return;
    const previousActive = this.workspace.get<string | null>(ACTIVE_ACCOUNT_KEY);
    const legacyUrl = this.state.get<string>('gitlabWorkspace.baseUrl');
    const legacyToken = await this.secrets.get(LEGACY_TOKEN_KEY);
    let migratedId = this.state.get<string>(MIGRATION_KEY);
    if (legacyUrl && legacyToken) {
      const knownId = this.state.get<number>('gitlabWorkspace.currentUserId');
      // Leave all legacy values intact when identity cannot be verified (including offline startup).
      const user = knownId && Number.isSafeInteger(knownId) && knownId > 0
        ? { id: knownId, username: '', name: 'GitLab 帳號 #' + knownId } as GitLabUser
        : await resolveUser(legacyUrl, legacyToken);
      const normalized = normalizeGitLabBaseUrl(legacyUrl);
      const id = accountId(normalized, user.id);
      const groupId = this.state.get<number>('gitlabWorkspace.selectedGroupId');
      const fullPath = this.state.get<string>('gitlabWorkspace.selectedGroupLabel');
      const existing = this.list().find(account => account.id === id);
      if (!await this.token(id)) await this.secrets.store(accountTokenKey(id), legacyToken);
      if (!existing) {
        await this.state.update(ACCOUNTS_KEY, [...this.list(), {
          id, baseUrl: normalized, userId: user.id, username: user.username, name: user.name,
          needsLogin: false, group: groupId && fullPath ? { id: groupId, fullPath } : undefined
        } satisfies GitLabAccount]);
      }
      if (previousActive === undefined) await this.workspace.update(ACTIVE_ACCOUNT_KEY, id);
      await this.state.update(MIGRATION_KEY, id);
      migratedId = id;
    }
    if (migratedId && this.list().some(account => account.id === migratedId) && await this.token(migratedId)) {
      // Clean up only after the profile, credential and active selection are durable.
      for (const key of ['gitlabWorkspace.baseUrl', 'gitlabWorkspace.currentUserId', 'gitlabWorkspace.selectedGroupId', 'gitlabWorkspace.selectedGroupLabel']) await this.state.update(key, undefined);
      await this.secrets.delete(LEGACY_TOKEN_KEY);
      await this.state.update(MIGRATION_KEY, undefined);
    }
    this.activeIdValue = this.workspace.get<string | null>(ACTIVE_ACCOUNT_KEY) ?? undefined;
    this.initialized = true;
    if (this.active && !await this.secrets.get(accountTokenKey(this.active.id))) {
      await this.markNeedsLogin(this.active.id);
      await this.select(undefined);
    }
  }

  async save(url: string, user: GitLabUser, token: string): Promise<GitLabAccount> {
    if (!Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.username !== 'string') throw new Error('GitLab 回傳的帳號身分無效。');
    const baseUrl = normalizeGitLabBaseUrl(url);
    const id = accountId(baseUrl, user.id);
    const previous = this.list();
    const priorToken = await this.secrets.get(accountTokenKey(id));
    const account: GitLabAccount = { id, baseUrl, userId: user.id, username: user.username, name: user.name ?? user.username,
      needsLogin: false, group: previous.find(item => item.id === id)?.group };
    try {
      await this.secrets.store(accountTokenKey(id), token);
      await this.state.update(ACCOUNTS_KEY, [...previous.filter(item => item.id !== id), account]);
      await this.select(id);
      return account;
    } catch (error) {
      await Promise.resolve(this.state.update(ACCOUNTS_KEY, previous)).catch(() => undefined);
      if (priorToken) await this.secrets.store(accountTokenKey(id), priorToken);
      else await this.secrets.delete(accountTokenKey(id));
      throw error;
    }
  }
  async select(id: string | undefined): Promise<void> {
    if (id && !this.list().some(account => account.id === id)) throw new Error('找不到此 GitLab 帳號。');
    await this.workspace.update(ACTIVE_ACCOUNT_KEY, id ?? null);
    this.activeIdValue = id;
  }
  async token(id: string): Promise<string | undefined> { return this.secrets.get(accountTokenKey(id)); }
  async setGroup(group: GitLabGroup | undefined): Promise<void> {
    const active = this.active;
    if (!active) return;
    await this.state.update(ACCOUNTS_KEY, this.list().map(account => account.id === active.id
      ? { ...account, group: group ? { id: group.id, fullPath: group.full_path } : undefined } : account));
  }
  async updateUser(user: GitLabUser): Promise<void> {
    const active = this.active;
    if (!active || active.userId !== user.id || (active.name === user.name && active.username === user.username)) return;
    await this.state.update(ACCOUNTS_KEY, this.list().map(account => account.id === active.id
      ? { ...account, name: user.name ?? user.username, username: user.username } : account));
  }
  async markNeedsLogin(id: string): Promise<void> {
    await this.state.update(ACCOUNTS_KEY, this.list().map(account => account.id === id ? { ...account, needsLogin: true } : account));
  }
  async logout(id: string, remove = false): Promise<void> {
    const previous = this.list();
    const previousToken = await this.token(id);
    try {
      await this.secrets.delete(accountTokenKey(id));
      await this.state.update(ACCOUNTS_KEY, remove ? previous.filter(account => account.id !== id)
        : previous.map(account => account.id === id ? { ...account, needsLogin: true } : account));
      if (this.activeId === id) await this.select(undefined);
    } catch (error) {
      await Promise.resolve(this.state.update(ACCOUNTS_KEY, previous)).catch(() => undefined);
      if (previousToken) await this.secrets.store(accountTokenKey(id), previousToken);
      throw error;
    }
  }
}
