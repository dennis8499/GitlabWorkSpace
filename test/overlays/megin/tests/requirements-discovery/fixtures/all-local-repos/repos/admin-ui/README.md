# Admin UI

The admin console lists orders in pages by calling `GET /v1/orders` and consumes the published `@group/order-contracts` types. Its current table has date and customer filters, but no export action. The TypeScript component and UI test are the source for the current interaction.
