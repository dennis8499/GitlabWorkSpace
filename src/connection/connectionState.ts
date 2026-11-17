export interface GitLabConnectionState {
  status: 'unconfigured' | 'unverified' | 'connecting' | 'connected' | 'auth-required' | 'unavailable';
}
export function connectionLabel(state?: GitLabConnectionState, configured = false): string {
  if (!state) return configured ? '已連線' : '尚未連線';
  return { unconfigured: '尚未設定', unverified: '尚未驗證', connecting: '正在連線', connected: '已連線',
    'auth-required': '需要重新登入', unavailable: '暫時無法連線' }[state.status];
}
/** Only current authenticated traffic informs health; optional API denial is local to that API. */
export function observeConnection(state: GitLabConnectionState, error?: unknown): GitLabConnectionState {
  if (!error) return { status: 'connected' };
  if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') return state;
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  if (status === 401) return { status: 'auth-required' };
  if (typeof status === 'number') return state;
  return { status: 'unavailable' };
}
