export interface GitLabRequestBudgetOptions { requests?: number; bytes?: number; timeoutMs?: number; }
export class GitLabBudgetExceededError extends Error {
  readonly complete = false;
  readonly effect = 'none';
  constructor(readonly budget: 'requests' | 'bytes' | 'time') {
    super('本批 GitLab 載入已達' + ({ requests: '請求數', bytes: '資料量', time: '時間' }[budget]) + '上限；已取得內容保留，可繼續載入。');
    this.name = 'GitLabBudgetExceededError';
  }
}
/** Shared by all scoped client clones, including GraphQL pagination, fallback and retries. */
export class GitLabRequestBudget {
  readonly requests: number;
  readonly bytes: number;
  readonly deadline: number;
  private sent = 0;
  private received = 0;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  constructor(options: GitLabRequestBudgetOptions = {}) {
    this.requests = options.requests ?? 20; this.bytes = options.bytes ?? 16 * 1024 * 1024;
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (![this.requests, this.bytes, timeoutMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new RangeError('Request budgets must be positive integers.');
    this.deadline = Date.now() + timeoutMs;
    this.timer = setTimeout(() => this.controller.abort(new GitLabBudgetExceededError('time')), timeoutMs);
    this.timer.unref?.();
  }
  get signal(): AbortSignal { return this.controller.signal; }
  get usedRequests(): number { return this.sent; }
  get receivedBytes(): number { return this.received; }
  reserve(): void {
    if (this.signal.aborted || Date.now() >= this.deadline) throw new GitLabBudgetExceededError('time');
    if (this.sent >= this.requests) throw new GitLabBudgetExceededError('requests');
    if (this.received >= this.bytes) throw new GitLabBudgetExceededError('bytes');
    this.sent++;
  }
  consume(bytes: number): void {
    this.received += bytes;
    if (this.received > this.bytes) throw new GitLabBudgetExceededError('bytes');
  }
  dispose(): void { clearTimeout(this.timer); }
}
