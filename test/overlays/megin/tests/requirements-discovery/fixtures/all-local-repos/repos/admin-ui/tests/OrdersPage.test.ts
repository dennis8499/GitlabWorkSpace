import { strict as assert } from "node:assert";
import { loadOrderPage, renderOrderTable } from "../src/OrdersPage";

const calls: unknown[][] = [];
const api = {
  async list(filters: unknown, cursor?: string) {
    calls.push([filters, cursor]);
    return { rows: [{ id: "o-2", customer: "A", total: 20 }], nextCursor: "p2" };
  },
};

const filters = { fromDate: "2026-09-01", customerId: "c-7" };
const page = await loadOrderPage(api, filters, "p1");
assert.deepEqual(calls, [[filters, "p1"]]);
assert.match(renderOrderTable(page), /Next/);
assert.doesNotMatch(renderOrderTable(page), /export/i);
