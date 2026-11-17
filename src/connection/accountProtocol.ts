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

export function accountStatus(account: GitLabAccount, activeAccountId: string | undefined, connected: boolean,
  health?: import('./connectionState').GitLabConnectionState): string {
  if (account.needsLogin || account.id === activeAccountId && health?.status === 'auth-required') return '需重新登入';
  if (account.id === activeAccountId && health && health.status !== 'connected') return {
    unconfigured: '已保存', unverified: '尚未驗證', connecting: '連線中', 'auth-required': '需重新登入', unavailable: '連線失敗'
  }[health.status];
  return connected && account.id === activeAccountId ? '目前使用' : '已保存';
}
