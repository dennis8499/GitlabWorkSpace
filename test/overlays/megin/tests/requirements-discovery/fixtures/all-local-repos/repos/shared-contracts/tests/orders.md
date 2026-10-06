# Contract compatibility tests

The API and admin client fixtures accept the same `OrderFilters`. `OrderExportRequest` omits the cursor field; adding pagination semantics to CSV export requires an explicit compatibility decision.
