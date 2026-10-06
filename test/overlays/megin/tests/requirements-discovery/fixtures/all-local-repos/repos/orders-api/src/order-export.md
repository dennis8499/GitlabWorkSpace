# CSV export route

`GET /v1/orders/export.csv` streams all matching orders for the requested date and customer filters; it does not take the page token. The route authorizes the `orders.read` permission and returns UTF-8 CSV with a header row.
