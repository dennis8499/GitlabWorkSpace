import type { OrderExportRequest, OrderFilters } from "../contracts/orders";

const listRequest: OrderFilters = { fromDate: "2026-09-01", customerId: "c-7" };
const exportRequest: OrderExportRequest = { fromDate: "2026-09-01", customerId: "c-7" };

void listRequest;
void exportRequest;
