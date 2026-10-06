export interface OrderFilters {
  fromDate?: string;
  customerId?: string;
}

export interface OrderExportRequest extends OrderFilters {
  // Exports stream every matching record, so this request has no page cursor.
}
