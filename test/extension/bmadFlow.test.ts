import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as vscode from 'vscode';
import { BmadWorkflowController } from '../../src/workspace/bmadWorkflowController';
import type { BmadWorkflowSnapshot } from '../../src/workspace/bmadProtocol';

const pause = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const prdStatus = (snapshot: BmadWorkflowSnapshot | undefined) => {
  const node = snapshot?.nodes.find(item => item.skill === 'bmad-prd');
  return snapshot?.steps.find(step => step.id === node?.id)?.status;
};

suite('BMAD dynamic artifact progress', () => {
  test('real filesystem events update draft/final/deleted artifacts and isolate root switches and disposal', async function () {
    this.timeout(30_000);
    const temporaryParent = await realpath(os.tmpdir());
    const temporary = await mkdtemp(path.join(temporaryParent, 'gw-bmad-flow-'));
    const extensionRoot = path.resolve(__dirname, '../../..');
    const catalog = await readFile(path.join(extensionRoot, 'resources/bmad/bmad-help.csv'), 'utf8');
    const values = new Map<string, unknown>();
    const activeWatchers = new Map<vscode.FileSystemWatcher, string>();
    const rawEvents: Array<{ path: string; time: number }> = [];
    const errors: string[] = [];
    const latencies: Record<string, number> = {};
    let publications = 0, createdWatchers = 0, disposedWatchers = 0;
    let controller: BmadWorkflowController | undefined;
    async function fixture(name: string): Promise<string> {
      const directory = path.join(temporary, name);
      await mkdir(path.join(directory, '_bmad', '_config'), { recursive: true });
      await writeFile(path.join(directory, '_bmad', '_config', 'manifest.yaml'), 'installation:\n  version: 6.12.4\n');
      await writeFile(path.join(directory, '_bmad', '_config', 'bmad-help.csv'), catalog);
      await writeFile(path.join(directory, '_bmad', 'config.toml'), [
        '[core]', 'output_folder = "_bmad-output"', '[modules.bmm]',
        'planning_artifacts = "{project-root}/_bmad-output/planning-artifacts"',
        'implementation_artifacts = "{project-root}/_bmad-output/implementation-artifacts"', ''
      ].join('\n'));
      return realpath(directory);
    }
    async function waitFor(check: () => boolean, label: string, timeout = 5000): Promise<void> {
      const started = performance.now();
      while (!check() && performance.now() - started < timeout) {
        assert.deepEqual(errors, [], 'Controller must not publish filesystem refresh errors');
        await pause(25);
      }
      assert.ok(check(), `${label}; observed=${JSON.stringify({ root: controller?.snapshot?.root, status: prdStatus(controller?.snapshot), events: rawEvents.slice(-8), errors })}`);
    }
    async function transition(label: string, mutate: () => Promise<void>, status: string): Promise<void> {
      const started = performance.now();
      await mutate();
      await waitFor(() => prdStatus(controller?.snapshot) === status, label);
      latencies[label] = Math.round(performance.now() - started);
      assert.ok(latencies[label] < 1000, `${label} must update within one second; observed ${latencies[label]} ms`);
    }
    try {
      const first = await fixture('第一個專案'), second = await fixture('第二個專案');
      controller = new BmadWorkflowController({
        store: {
          get: <T>(key: string, fallback: T) => values.has(key) ? values.get(key) as T : fallback,
          update: async (key: string, value: unknown) => { values.set(key, value); }
        },
        bundledCatalog: async () => catalog,
        watch: (directory, changed) => {
          const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(directory), '**/*'));
          createdWatchers++; activeWatchers.set(watcher, directory);
          const onEvent = (uri: vscode.Uri) => { rawEvents.push({ path: uri.fsPath, time: performance.now() }); changed(uri.fsPath); };
          const subscriptions = [watcher.onDidCreate(onEvent), watcher.onDidChange(onEvent), watcher.onDidDelete(onEvent)];
          return { dispose: () => {
            subscriptions.forEach(subscription => subscription.dispose()); watcher.dispose();
            if (activeWatchers.delete(watcher)) disposedWatchers++;
          } };
        },
        changed: () => { publications++; }, error: message => { errors.push(message); }
      });
      controller.setContext(first, 'first-root', true);
      await controller.refresh();
      assert.equal(prdStatus(controller.snapshot), 'not-observed');
      assert.ok(activeWatchers.size > 0);
      // Let VS Code attach its native watcher before creating a previously missing output tree.
      await pause(200);
      const firstArtifact = path.join(first, '_bmad-output', 'planning-artifacts', 'prd.md');
      await transition('mkdir-and-draft', async () => {
        await mkdir(path.dirname(firstArtifact), { recursive: true });
        await writeFile(firstArtifact, '---\nstatus: draft\n---\nDraft PRD\n');
      }, 'draft');
      await transition('final-write', () => writeFile(firstArtifact, '---\nstatus: final\n---\nFinal PRD\n'), 'complete');
      await transition('artifact-delete', () => unlink(firstArtifact), 'not-observed');
      await transition('draft-recreate', () => writeFile(firstArtifact, '---\nstatus: draft\n---\nDraft again\n'), 'draft');

      // Queue an actual first-root event, then switch while its refresh is debouncing.
      const previousEvents = rawEvents.length;
      await writeFile(firstArtifact, '---\nstatus: final\n---\nOld-root final\n');
      await waitFor(() => rawEvents.length > previousEvents, 'old-root event must reach the real watcher');
      controller.setContext(second, 'second-root', true);
      await controller.refresh();
      assert.equal(controller.snapshot?.root, second);
      assert.equal(prdStatus(controller.snapshot), 'not-observed');
      const secondRevision = controller.snapshot!.revision;
      assert.ok([...activeWatchers.values()].every(directory => directory === second || directory.startsWith(`${second}${path.sep}`)), 'Old-root watchers must be disposed when context changes');
      await writeFile(firstArtifact, '---\nstatus: draft\n---\nA later old-root edit\n');
      await pause(400);
      assert.equal(controller.snapshot?.root, second);
      assert.equal(controller.snapshot?.revision, secondRevision, 'Old-root events must not overwrite the selected snapshot');
      const secondArtifact = path.join(second, '_bmad-output', 'planning-artifacts', 'prd.md');
      await transition('new-root-draft', async () => {
        await mkdir(path.dirname(secondArtifact), { recursive: true });
        await writeFile(secondArtifact, '---\nstatus: draft\n---\nNew root draft\n');
      }, 'draft');

      const finalSnapshot = controller.snapshot, finalPublications = publications;
      controller.dispose();
      assert.equal(activeWatchers.size, 0);
      assert.equal(disposedWatchers, createdWatchers);
      await writeFile(secondArtifact, '---\nstatus: final\n---\nAfter disposal\n');
      await pause(400);
      assert.equal(controller.snapshot, finalSnapshot);
      assert.equal(publications, finalPublications, 'Disposal must prevent subsequent refresh publications');
      assert.deepEqual(errors, []);
      console.log(`[BMAD native watcher latency ms] ${JSON.stringify(latencies)}`);
    } finally {
      controller?.dispose();
      for (const watcher of activeWatchers.keys()) watcher.dispose();
      assert.equal(path.dirname(await realpath(temporary)), temporaryParent);
      assert.ok(path.basename(temporary).startsWith('gw-bmad-flow-'));
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
