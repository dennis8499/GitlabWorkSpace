import { strict as assert } from "node:assert";
import { appendLedgerEntry, subscriptions } from "../src/invoiceWorker";

assert.deepEqual(subscriptions, ["invoice.finalized.v1"]);
assert.equal(appendLedgerEntry({ invoiceId: "i-1", orderId: "o-1", total: 10 }), "invoice-ledger:i-1:10");
