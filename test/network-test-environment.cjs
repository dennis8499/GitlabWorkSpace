// Explicit test-only policy: mock traffic uses the real coordinator without waiting production seconds.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
if (!process.env.GITLAB_WORKSPACE_RUNTIME_DIR) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'glw-network-test-'));
  process.env.GITLAB_WORKSPACE_RUNTIME_DIR = root;
  fs.writeFileSync(path.join(root, 'network-policy.json'), JSON.stringify({ schema: 'GitLabWorkspaceNetworkPolicy/v1', api: { startsPerSecond: 10000, concurrency: 128 } }));
  process.once('exit', () => {
    if (path.dirname(root) === parent && path.basename(root).startsWith('glw-network-test-')) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
}
