import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalNetworkLease } from '../../src/api/localNetworkLease';
import { captureGitProcess } from '../../src/git/gitProcess';

async function waitFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    try { await readFile(file); return; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  throw new Error('Cross-runtime fixture did not start.');
}
test('TypeScript and the Reviewer Python runtime serialize the same Git lease in both directions', { timeout: 30_000 }, async t => {
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, 'glw-network-interop-'));
  t.after(async () => { assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('glw-network-interop-')); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }); });
  const repository = path.resolve(__dirname, '../../..');
  const snapshot = JSON.parse(await readFile(path.join(repository, 'test/fixtures/workflowkit-release-1.0.0/capabilities.json'), 'utf8')).sources['merge-reviewer'];
  assert.match(snapshot.filename, /^merge-reviewer-[0-9.]+\.zip$/);
  assert.equal(snapshot.entryRoot, 'merge-reviewer');
  const archive = path.join(repository, 'test/fixtures/workflowkit-release-1.0.0/sources', snapshot.filename);
  const script = path.join(root, 'fixture.py'), ready = path.join(root, 'ready'), acquired = path.join(root, 'acquired');
  await writeFile(script, 'import sys,time,hashlib,io,zipfile\nfrom pathlib import Path\nsys.dont_write_bytecode=True\nroot=Path(sys.argv[3])\ndata=Path(sys.argv[1]).read_bytes()\nassert hashlib.sha256(data).hexdigest()==sys.argv[2],"Frozen Reviewer archive digest differs"\nwith zipfile.ZipFile(io.BytesIO(data)) as archive:\n info=archive.getinfo("merge-reviewer/scripts/git_network_lease.py")\n assert info.file_size<1024*1024 and (info.external_attr>>16)&0o170000!=0o120000\n module=archive.read(info)\nruntime=root/"reviewer-runtime"\nruntime.mkdir()\n(runtime/"git_network_lease.py").write_bytes(module)\nsys.path.insert(0,str(runtime))\nfrom git_network_lease import DirectoryLease\n(root/"ready").write_text("ready")\nlease=DirectoryLease(root,timeout=10).acquire()\n(root/"acquired").write_text("acquired")\ntime.sleep(0.3)\nlease.release(process_tree_confirmed=True)\n');
  const first = await LocalNetworkLease.acquire(path.join(root, 'git-network.lock'), 'git');
  const child = spawn(process.execPath, [path.join(repository, 'scripts/run-python.mjs'), script, archive, snapshot.archiveSha256, root], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data.toString(); });
  const done = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(stderr))); });
  await Promise.race([waitFile(ready), done]); await assert.rejects(readFile(acquired), { code: 'ENOENT' });
  await first.update({ processTreeConfirmed: true }); await first.release();
  await waitFile(acquired);
  const began = Date.now();
  const second = await LocalNetworkLease.acquire(path.join(root, 'git-network.lock'), 'git', { timeoutMs: 10_000 });
  assert.ok(Date.now() - began >= 150, 'TypeScript waited for the Python owner to release');
  await second.update({ processTreeConfirmed: true }); await second.release(); await done;
});

test('the network Git runner confirms the real exit code before releasing its lease', { timeout: 20_000 }, async () => {
  const result = await captureGitProcess(process.execPath, ['-e', 'process.stdout.write("complete");process.exitCode=7'], { network: true, timeoutMs: 15_000 });
  assert.equal(result.code, 7); assert.equal(result.stdout, 'complete');
  const next = await captureGitProcess('git', ['--version'], { network: true, timeoutMs: 15_000 });
  assert.equal(next.code, 0); assert.match(next.stdout, /^git version /);
});
