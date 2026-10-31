'use strict';

// Isolated synthetic measurement of the production receipt store. It creates
// uniquely named sample data below this evidence directory and never deletes it.
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { OperationReceiptFileStore } = require(path.resolve('out/src/workspace/operationReceiptStore.js'));

const root = path.join(__dirname, 'evidence', `receipt-sample-${Date.now()}-${process.pid}`);
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const round = n => Math.round(n * 1000) / 1000;
const state = i => ({ requestId: `audit-${i}`, correlationId: `correlation-${i}`, scopeRevision: 'synthetic-scope',
  resourceKey: `resource-${i}`, action: 'audit-write', label: 'synthetic', phase: 'done',
  status: 'succeeded', effect: 'applied', startedAt: 1_700_000_000_000 });

async function measure(count) {
  const files = await fs.readdir(root);
  const sizes = await Promise.all(files.map(file => fs.stat(path.join(root, file))));
  const reader = new OperationReceiptFileStore(root);
  const lookup = [];
  let hits = 0;
  for (let i = 0; i < 100; i++) {
    const id = count ? `audit-${Math.floor(i * count / 100)}` : `missing-${i}`;
    const start = performance.now();
    const result = await reader.get(id);
    lookup.push(performance.now() - start);
    if (result) hits++;
  }
  if (hits !== (count ? 100 : 0)) throw new Error(`Unexpected hits for ${count}: ${hits}`);
  return { operations: count, files: files.length, bytes: sizes.reduce((n, item) => n + item.size, 0),
    lookups: lookup.length, hits, lookupP50Ms: round(percentile(lookup, 0.5)), lookupP95Ms: round(percentile(lookup, 0.95)),
    lookupMaxMs: round(Math.max(...lookup)) };
}

(async () => {
  await fs.mkdir(root, { recursive: true });
  const store = new OperationReceiptFileStore(root);
  const measurements = [await measure(0)];
  let count = 0;
  for (const target of [1000, 10000, 100000]) {
    const start = performance.now();
    while (count < target) {
      await store.save(state(count++));
      if (count % 10000 === 0) console.log(`saved ${count} receipts`);
    }
    const writeElapsedMs = performance.now() - start;
    const result = await measure(target);
    result.batchWriteMs = round(writeElapsedMs);
    measurements.push(result);
    console.log(JSON.stringify(result));
  }
  const output = { description: 'Synthetic operation receipt storage; two identifiers per operation, sequential writes, cold store per checkpoint.',
    node: process.version, sampleDirectory: path.basename(root), measurements };
  await fs.writeFile(path.join(root, 'results.json'), JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify(output, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
