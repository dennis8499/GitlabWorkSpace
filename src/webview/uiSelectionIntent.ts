import type { UiIntentField, UiIntentId, UiIntentMetadata, UiIntentValues } from '../workspace/uiIntentProtocol';

type Values = Partial<UiIntentValues>;
interface Pending { id: UiIntentId }

/** Selection intent is independent from the longer-running data-read lifecycle. */
export class UiSelectionIntents {
  private readonly viewId = globalThis.crypto?.randomUUID?.() ?? `view-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  private sequence = 0;
  private generation = 0;
  private lastNavigationEvent = -1;
  private sessionId?: string;
  private readonly retiredSessions = new Set<string>();
  private readonly pending = new Map<UiIntentField, Pending>();
  private authoritative: UiIntentValues;

  constructor(initial: UiIntentValues) { this.authoritative = { ...initial }; }
  get hostGeneration(): number { return this.generation; }

  begin(field: UiIntentField): UiIntentMetadata {
    const id = { viewId: this.viewId, sequence: ++this.sequence };
    this.pending.set(field, { id });
    return { uiIntentId: id, hostNavigationGeneration: this.generation };
  }

  snapshot(values: Values, generation?: number, sessionId?: string): Values {
    if (sessionId && this.retiredSessions.has(sessionId)) return {};
    if (sessionId && this.sessionId !== sessionId) {
      if (this.sessionId) { this.retiredSessions.add(this.sessionId); this.pending.clear(); }
      this.sessionId = sessionId; this.generation = 0; this.lastNavigationEvent = -1;
    }
    if (generation !== undefined && generation < this.generation) return {};
    if (generation !== undefined) this.generation = generation;
    Object.assign(this.authoritative, values);
    return Object.fromEntries(Object.entries(values).filter(([key]) => !this.pending.has(key as UiIntentField))) as Values;
  }

  result(message: { uiIntentId: UiIntentId; field: UiIntentField; value: UiIntentValues[UiIntentField]; hostNavigationGeneration: number }): Values | undefined {
    const pending = this.pending.get(message.field);
    if (!pending || pending.id.viewId !== message.uiIntentId.viewId || pending.id.sequence !== message.uiIntentId.sequence) return;
    this.generation = Math.max(this.generation, message.hostNavigationGeneration);
    this.pending.delete(message.field);
    Object.assign(this.authoritative, { [message.field]: message.value });
    return { [message.field]: message.value } as Values;
  }

  blocked(field: UiIntentField, id: UiIntentId | undefined): Values {
    const pending = this.pending.get(field);
    if (!id || !pending || pending.id.viewId !== id.viewId || pending.id.sequence !== id.sequence) return {};
    this.pending.delete(field);
    return { [field]: this.authoritative[field] } as Values;
  }

  navigate(generation: number, values: Values, sessionId?: string): Values {
    if (sessionId && this.sessionId && sessionId !== this.sessionId) return {};
    if (generation < this.generation || generation <= this.lastNavigationEvent) return {};
    this.generation = generation;
    this.lastNavigationEvent = generation;
    for (const field of Object.keys(values) as UiIntentField[]) this.pending.delete(field);
    Object.assign(this.authoritative, values);
    return values;
  }

  reset(): void { this.pending.clear(); }
}
