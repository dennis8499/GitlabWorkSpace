import type { OrderFilters } from "@group/order-contracts";

export interface OrderPage {
  rows: Array<{ id: string; customer: string; total: number }>;
  nextCursor?: string;
}

export interface OrdersApi {
  list(filters: OrderFilters, cursor?: string): Promise<OrderPage>;
}

export async function loadOrderPage(api: OrdersApi, filters: OrderFilters, cursor?: string): Promise<OrderPage> {
  return api.list(filters, cursor);
}

export function renderOrderTable(page: OrderPage): string {
  const rows = page.rows.map((row) => `<tr><td>${row.id}</td><td>${row.customer}</td></tr>`).join("");
  return `<section><table>${rows}</table>${page.nextCursor ? "<button>Next</button>" : ""}</section>`;
}
