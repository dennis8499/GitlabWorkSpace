export interface InvoiceFinalized {
  invoiceId: string;
  orderId: string;
  total: number;
}

export const subscriptions = ["invoice.finalized.v1"];

export function appendLedgerEntry(event: InvoiceFinalized): string {
  return `invoice-ledger:${event.invoiceId}:${event.total}`;
}
