import type { HostNavigation, UiIntentField, UiIntentMetadata, UiIntentValues } from './uiIntentProtocol';

export interface UiIntentTicket extends UiIntentMetadata { field: UiIntentField; stale: boolean; }

/** Serializes only short mutations. Data reads run after acknowledgement. */
export class HostUiIntents {
  generation = 0;
  private readonly latest = new Map<UiIntentField, UiIntentTicket>();
  private readonly navigation = new Map<UiIntentField, number>();
  private readonly queues = new Map<UiIntentField, Promise<unknown>>();

  register(field: UiIntentField, metadata: UiIntentMetadata): UiIntentTicket {
    const previous = this.latest.get(field);
    const baseline = metadata.hostNavigationGeneration ?? (metadata.uiIntentId ? 0 : this.generation);
    if (metadata.uiIntentId && previous?.uiIntentId && previous.uiIntentId.viewId === metadata.uiIntentId.viewId
      && previous.uiIntentId.sequence === metadata.uiIntentId.sequence && previous.hostNavigationGeneration === baseline) return previous;
    const stale = baseline < (this.navigation.get(field) ?? 0)
      || !!(metadata.uiIntentId && previous?.uiIntentId
        && previous.uiIntentId.viewId === metadata.uiIntentId.viewId
        && previous.uiIntentId.sequence > metadata.uiIntentId.sequence);
    const ticket = { field, uiIntentId: metadata.uiIntentId, hostNavigationGeneration: baseline, stale };
    if (!stale) this.latest.set(field, ticket);
    return ticket;
  }

  current(ticket: UiIntentTicket): boolean {
    return !ticket.stale && this.latest.get(ticket.field) === ticket
      && (ticket.hostNavigationGeneration ?? 0) >= (this.navigation.get(ticket.field) ?? 0);
  }

  navigate(values: Partial<UiIntentValues>): HostNavigation {
    const generation = ++this.generation;
    for (const field of Object.keys(values) as UiIntentField[]) {
      this.navigation.set(field, generation);
      this.latest.delete(field);
    }
    return { type: 'hostNavigation', generation, values };
  }

  async apply(ticket: UiIntentTicket, mutate: (current: () => boolean) => Promise<void>): Promise<boolean> {
    const previous = this.queues.get(ticket.field) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      if (!this.current(ticket)) return false;
      await mutate(() => this.current(ticket));
      return this.current(ticket);
    });
    this.queues.set(ticket.field, task);
    try { return await task; }
    finally { if (this.queues.get(ticket.field) === task) this.queues.delete(ticket.field); }
  }
}
