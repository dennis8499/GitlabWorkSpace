# Invoice worker

Consumes `invoice.finalized.v1` events and writes invoice ledger entries. It does not import `OrderFilters`, call the admin orders list, or subscribe to order-export events.
