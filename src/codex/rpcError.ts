export type CodexErrorCategory = 'transport' | 'timeout' | 'protocol' | 'authentication' | 'policy' | 'unsupported' | 'quota' | 'provider' | 'cleanup' | 'cancelled' | 'server';
export type CodexDelivery = 'not-sent' | 'possibly-sent' | 'acknowledged';
const categories: Record<string, CodexErrorCategory> = {
  unauthorized: 'authentication', authenticationRequired: 'authentication', authRequired: 'authentication',
  modelProviderMismatch: 'provider', rateLimitExceeded: 'quota', usageLimitExceeded: 'quota', quotaExceeded: 'quota',
  policyViolation: 'policy', managedRequirements: 'policy', permissionDenied: 'policy', unsupported: 'unsupported', methodNotFound: 'unsupported'
};
const labels: Record<CodexErrorCategory, string> = {
  transport: 'Codex 通訊已中斷；請核對任務狀態。', timeout: 'Codex 回應逾時；請先核對結果。', protocol: 'Codex 傳回無效的 JSON-RPC 訊息。',
  authentication: 'Codex 登入已失效，請重新登入後核對任務。', policy: 'Codex 管理政策不允許此操作，請核對執行權限。',
  unsupported: '目前 Codex CLI 不支援此功能，請檢查版本。', quota: 'Codex 使用額度已達上限，請核對額度與重設時間。',
  provider: '原對話的模型供應者與目前設定不同，請切回原設定或分支對話。', cleanup: 'Codex 程序停止結果待核對；保留執行鎖。',
  cancelled: 'Codex 請求已取消。', server: 'Codex 請求失敗，請核對任務紀錄。'
};
/** Server error text may contain credentials. Only classifications leave the transport. */
export class CodexRpcError extends Error {
  constructor(readonly category: CodexErrorCategory, readonly method?: string, readonly rpcCode?: number,
    readonly delivery: CodexDelivery = 'not-sent') {
    super(labels[category] + (rpcCode === undefined ? '' : ` (${rpcCode})`)); this.name = 'CodexRpcError';
  }
  static from(method: string, error: { code: number; data?: unknown }): CodexRpcError {
    const data = error.data && typeof error.data === 'object' ? error.data as Record<string, unknown> : {};
    const category = typeof data.type === 'string' ? categories[data.type] : undefined;
    return new CodexRpcError(category ?? (error.code === -32601 ? 'unsupported' : error.code === 401 ? 'authentication'
      : error.code === 429 ? 'quota' : 'server'), method, error.code, 'acknowledged');
  }
}
