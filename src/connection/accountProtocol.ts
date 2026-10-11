export interface GitLabAccount {
  id: string;
  baseUrl: string;
  userId: number;
  username: string;
  name: string;
  needsLogin: boolean;
  group?: { id: number; fullPath: string };
}

export interface AccountPanelIntent {
  id: string;
  startLogin: boolean;
  accountId?: string;
}

export type AccountOperation = 'login' | 'switch' | 'logout' | 'remove';

export function accountStatus(account: GitLabAccount, activeAccountId: string | undefined, connected: boolean): string {
  return account.needsLogin ? '需重新登入' : connected && account.id === activeAccountId ? '目前使用' : '已保存';
}
