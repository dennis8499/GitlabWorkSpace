# Performance benchmark record

## Current run

- Measured: 2026-10-05 07:51 UTC
- Environment: Windows, Node.js v24.21.0, exposed garbage collector
- Reproduce with: `npm run benchmark:performance`
- Validation on the same checkout: `npm test` and `npm run typecheck:webview`
- Workloads: small (50 Repos / 100 Issues / 50 graph nodes), primary (500 / 1,000 / 500), stress (2,000 / 10,000 / 2,000)

The benchmark calls the production folder-name, read-cache, graph-patch, capability-query, and virtual-window helpers with synthetic data. It does not include a live GitLab request, actual local Repo folders, a VS Code Webview, or browser rendering. The legacy Repo-path and full-snapshot measurements are comparison implementations run in the same process. Heap figures are sampled Node process data for the synthetic graph workload, not Webview memory measurements.

| Workload / metric | Before or full payload | Current path | Change |
| --- | ---: | ---: | ---: |
| 50 Repo path mapping, median | 2.37 ms | 0.20 ms | 91.65% less elapsed time |
| 500 Repo path mapping, median | 1,321.16 ms | 1.10 ms | 99.92% less elapsed time |
| 2,000 Repo path mapping | Legacy cubic comparison skipped | 3.72 ms | Current path measured |
| 8 identical concurrent reads | 8 API calls | 1 API call | 7 calls coalesced |
| 8 warm reads | 144,454 B response fixture | 0 network bytes | Served by cache |
| 30 graph updates, small | 770,422 B full snapshots | 19,538 B deltas | 97.46% less serialized data |
| 30 graph updates, primary | 7,952,812 B full snapshots | 19,538 B deltas | 99.75% less serialized data |
| 30 graph updates, stress | 33,513,202 B full snapshots | 19,538 B deltas | 99.94% less serialized data |
| Primary Issue list at mid-scroll | 1,000 rows | 32 mounted rows | Variable-height window plus overscan |
| Stress Issue list at mid-scroll | 10,000 rows | 32 mounted rows | Variable-height window plus overscan |

The sampled heap delta was 4.09 MB for the small case, 34.95 MB for primary, and 34.62 MB for stress. These values include the synthetic benchmark's in-memory data and are not a before/after measurement of the extension Webview.

## Capability-probe transfer

The pinned `v16.11.10-ee` fixture is a minimal CE-compatible schema contract, not a complete schema export. The current query planner makes three targeted batches for 23 types. Their combined request bodies are 2,579 bytes; the old whole-schema query body was 316 bytes. Request text therefore grows because the targeted probe asks for field, argument, and input details. The response payloads cannot be compared from this fixture, so the planned 80% capability-probe transfer reduction is **not yet verified**. It requires a captured full-schema and targeted response from an authenticated GitLab CE 16.11.10 instance. No response-size or live-instance improvement is claimed here.

## Historical measurement (2026-10-02)

The earlier benchmark run recorded 1,561.47 ms to 1.49 ms for 500 Repo path mapping, eight concurrent reads to one, a 99.97% reduction for a representative timer payload, and a 62.36% reduction for a representative graph payload. Its graph fixture and comparison path differ from the current production-helper benchmark above, so the values are retained as historical context rather than combined into one series.

The benchmark is useful for comparing algorithm and serialized-payload changes on the same machine. Live GitLab latency, bytes transferred, Git command counts against real folders, Webview rendering, and resident memory still need acceptance measurements in the target environment.
