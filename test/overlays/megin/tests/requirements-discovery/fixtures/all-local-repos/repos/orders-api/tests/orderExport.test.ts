import { strict as assert } from "node:assert";
import { exportOrders } from "../src/orderExport";

const request = { fromDate: "2026-09-01", customerId: "c-7" };
const rows = [
  { id: "o-1", customerId: "c-7", createdAt: "2026-09-03", total: 10 },
  { id: "o-2", customerId: "c-7", createdAt: "2026-09-04", total: 20 },
  { id: "o-3", customerId: "c-8", createdAt: "2026-09-04", total: 30 },
];

const csv = exportOrders(request, { permissions: ["orders.read"] }, rows);
assert.match(csv, /o-1/);
assert.match(csv, /o-2/);
assert.doesNotMatch(csv, /o-3/);
assert.throws(() => exportOrders(request, { permissions: [] }, rows), /forbidden/);
