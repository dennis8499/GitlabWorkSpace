import type { OrderExportRequest } from "@group/order-contracts";

export interface Caller {
  permissions: string[];
}

export interface OrderRow {
  id: string;
  customerId: string;
  createdAt: string;
  total: number;
}

export function exportOrders(request: OrderExportRequest, caller: Caller, rows: OrderRow[]): string {
  if (!caller.permissions.includes("orders.read")) throw new Error("forbidden");
  const matching = rows.filter((row) => {
    if (request.customerId && row.customerId !== request.customerId) return false;
    if (request.fromDate && row.createdAt < request.fromDate) return false;
    return true;
  });
  return ["id,customer_id,created_at,total", ...matching.map((row) =>
    `${row.id},${row.customerId},${row.createdAt},${row.total}`,
  )].join("\n");
}
