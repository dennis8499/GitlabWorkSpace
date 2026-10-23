import { AsyncLocalStorage } from 'node:async_hooks';

export interface ReadObservation {
  dataSource?: 'cache' | 'network' | 'mixed';
  fetchedAt?: number;
  expiresAt?: number;
  transportStage?: 'waiting' | 'sending' | 'cooldown';
  retryAt?: number;
}
const observers = new AsyncLocalStorage<(event: ReadObservation) => void>();
export function observeRead(event: ReadObservation): void {
  try { observers.getStore()?.(event); } catch { /* Presentation cannot fail a request. */ }
}
export function withReadObservation<T>(observer: ((event: ReadObservation) => void) | undefined, task: () => T): T {
  if (!observer) return task();
  const parent = observers.getStore();
  return observers.run(event => { parent?.(event); observer(event); }, task);
}
