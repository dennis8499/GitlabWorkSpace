import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as vscode from 'vscode';
import { BmadWorkflowController } from '../../src/workspace/bmadWorkflowController';
import { parseBmadCatalog } from '../../src/workspace/bmadWorkflow';
import type { BmadArtifact, BmadStep, BmadWorkflowSnapshot } from '../../src/workspace/bmadProtocol';

const pause = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const prdStatus = (snapshot: BmadWorkflowSnapshot | undefined) => {
  const node = snapshot?.nodes.find(item => item.skill === 'bmad-prd');
  return snapshot?.steps.find(step => step.id === node?.id)?.status;
};
const buildStep = (snapshot: BmadWorkflowSnapshot | undefined): BmadStep | undefined => {
  const node = snapshot?.nodes.find(item => item.skill === 'bmad-build');
  return snapshot?.steps.find(step => step.id === node?.id);
};

suite('BMAD dynamic artifact progress', () => {
  test('real filesystem events track root/custom artifacts, native Build stages, visibility and root switches', async function () {
    this.timeout(30_000);
    const temporaryParent = await realpath(os.tmpdir());
    const temporary = await mkdtemp(path.join(temporaryParent, 'gw-bmad-flow-'));
    const extensionRoot = path.resolve(__dirname, '../../..');
    const catalog = await readFile(path.join(extensionRoot, 'resources/bmad/bmad-help.csv'), 'utf8');
    const activeWatchers = new Map<vscode.FileSystemWatcher, string>();
    const rawEvents: Array<{ path: string; time: number }> = [];
    const errors: string[] = [];
    const latencies: Record<string, number> = {};
    let publications = 0, createdWatchers = 0, disposedWatchers = 0;
    let controller: BmadWorkflowController | undefined;
    async function fixture(name: string, outputFolder = '_bmad-output'): Promise<string> {
      const directory = path.join(temporary, name);
      await mkdir(path.join(directory, '_bmad', '_config'), { recursive: true });
      await writeFile(path.join(directory, '_bmad', '_config', 'manifest.yaml'), 'installation:\n  version: 6.12.4\n');
      await writeFile(path.join(directory, '_bmad', '_config', 'bmad-help.csv'), catalog);
      const planning = outputFolder === '.' ? '{project-root}' : `{project-root}/${outputFolder}/planning-artifacts`;
      const implementation = outputFolder === '.' ? '{project-root}' : `{project-root}/${outputFolder}/implementation-artifacts`;
      await writeFile(path.join(directory, '_bmad', 'config.toml'), [
        '[core]', `output_folder = "${outputFolder}"`, '[modules.bmm]',
        `planning_artifacts = "${planning}"`,
        `implementation_artifacts = "${implementation}"`, ''
      ].join('\n'));
      await mkdir(path.join(directory, '_bmad', 'scripts'), { recursive: true });
      await writeFile(path.join(directory, '_bmad', 'scripts', 'resolve_config.py'), '# External installer fixture');
      await writeFile(path.join(directory, '_bmad', 'scripts', 'render_skill.py'), '# External installer fixture');
      for (const skill of new Set(['bmad-help', ...parseBmadCatalog(catalog).map(node => node.skill)])) {
        await mkdir(path.join(directory, '.agents', 'skills', skill), { recursive: true });
        await writeFile(path.join(directory, '.agents', 'skills', skill, 'SKILL.md'), `# ${skill}`);
      }
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
    async function observedTransition(label: string, mutate: () => Promise<void>, check: () => boolean): Promise<void> {
      const started = performance.now();
      await mutate();
      await waitFor(check, label);
      latencies[label] = Math.round(performance.now() - started);
      assert.ok(latencies[label] < 1000, `${label} must update within one second; observed ${latencies[label]} ms`);
    }
    async function transition(label: string, mutate: () => Promise<void>, status: string): Promise<void> {
      await observedTransition(label, mutate, () => prdStatus(controller?.snapshot) === status);
    }
    try {
      const first = await fixture('第一個專案'), second = await fixture('第二個專案');
      controller = new BmadWorkflowController({
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
      const external = path.join(temporary, '使用者CLI初始化');
      await mkdir(external);
      controller.setContext(external, 'external-root', true);
      await controller.refresh();
      assert.equal(controller.snapshot?.installation.state, 'missing');
      assert.equal(controller.snapshot?.observation.state, 'watching');
      await pause(200);
      await observedTransition('external-cli-install', async () => { await fixture('使用者CLI初始化'); },
        () => controller?.snapshot?.installation.state === 'ready' && controller.snapshot.codex.state === 'ready');
      const buildSkill = path.join(external, '.agents', 'skills', 'bmad-build', 'SKILL.md');
      await observedTransition('external-codex-skill-delete', () => unlink(buildSkill),
        () => controller?.snapshot?.codex.state === 'partial' && !controller.snapshot.codex.skills.includes('bmad-build'));
      await observedTransition('external-codex-skill-restore', () => writeFile(buildSkill, '# Restored by user CLI'),
        () => controller?.snapshot?.codex.state === 'ready');
      const renderer = path.join(external, '_bmad', 'scripts', 'render_skill.py');
      await observedTransition('external-runtime-delete', () => unlink(renderer),
        () => controller?.snapshot?.installation.state === 'partial');
      await observedTransition('external-runtime-restore', () => writeFile(renderer, '# Restored by user CLI'),
        () => controller?.snapshot?.installation.state === 'ready');
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

      controller.setContext(second, 'second-root', false);
      assert.equal(activeWatchers.size, 0, 'Hidden pages must release their native filesystem observers');
      const hiddenPublications = publications;
      await writeFile(secondArtifact, '---\nstatus: final\n---\nChanged while hidden\n');
      await pause(250);
      assert.equal(publications, hiddenPublications, 'Hidden edits must not trigger background reads');
      await observedTransition('hidden-write-show-catch-up', async () => {
        controller!.setContext(second, 'second-root', true);
        await controller!.refresh();
      }, () => prdStatus(controller?.snapshot) === 'complete');
      assert.ok(activeWatchers.size > 0);

      const custom = await fixture('自訂輸出', 'generated/custom');
      controller.setContext(custom, 'custom-root', true);
      await controller.refresh();
      await pause(200);
      const customPlanning = path.join(custom, 'generated', 'custom', 'planning-artifacts');
      await transition('custom-output-first-create', async () => {
        await mkdir(customPlanning, { recursive: true });
        await writeFile(path.join(customPlanning, 'prd.md'), '---\nstatus: draft\n---\nCustom output PRD\n');
      }, 'draft');
      const customImplementation = path.join(custom, 'generated', 'custom', 'implementation-artifacts');
      const buildRecord = path.join(customImplementation, 'spec-feature.md');
      for (const nativeStatus of ['draft', 'ready-for-dev', 'in-progress', 'in-review', 'blocked', 'done']) {
        await observedTransition(`build-${nativeStatus}`, async () => {
          await mkdir(customImplementation, { recursive: true });
          await writeFile(buildRecord, `---\nstatus: ${nativeStatus}\n---\nBuild record\n`);
        }, () => buildStep(controller?.snapshot)?.artifacts.some(artifact => artifact.path === buildRecord && artifact.nativeStatus === nativeStatus) === true);
        const artifact: BmadArtifact = buildStep(controller.snapshot)!.artifacts.find(item => item.path === buildRecord)!;
        assert.ok(artifact.stage, 'Native Build state must expose its current phase');
        assert.ok(artifact.observedAt && !Number.isNaN(Date.parse(artifact.observedAt)), 'Build state must include its last observation time');
        assert.equal(artifact.status, nativeStatus === 'done' ? 'complete' : nativeStatus === 'blocked' ? 'blocked' : 'draft');
      }
      const sprint = path.join(customImplementation, 'sprint-status.yaml');
      await observedTransition('parallel-classic-stories', () => writeFile(sprint,
        'development_status:\n  1-1-first: review\n  1-2-second: in-progress\n'),
      () => controller?.snapshot?.stories.length === 2 && buildStep(controller?.snapshot)?.status === 'draft');
      assert.deepEqual(controller.snapshot!.stories.map(story => story.nativeStatus), ['review', 'in-progress']);
      assert.equal(buildStep(controller.snapshot)!.artifacts.find(item => item.path === buildRecord)?.status, 'complete', 'Individual Build completion survives unfinished Story tracking');

      const rootOutput = await fixture('根目錄輸出', '.');
      controller.setContext(rootOutput, 'root-output', true);
      await controller.refresh();
      assert.equal(controller.snapshot?.watchRootArtifacts, true);
      await pause(200);
      const rootArtifact = path.join(rootOutput, 'prd.md');
      await transition('root-output-first-create', () => writeFile(rootArtifact, '---\nstatus: draft\n---\nRoot PRD\n'), 'draft');
      await transition('root-output-modify', () => writeFile(rootArtifact, '---\nstatus: final\n---\nRoot PRD final\n'), 'complete');
      await observedTransition('root-output-yaml-create', () => writeFile(path.join(rootOutput, 'sprint-status.yaml'),
        'development_status:\n  1-1-root-story: in-progress\n'),
      () => controller?.snapshot?.stories[0]?.nativeStatus === 'in-progress');
      await transition('root-output-delete', () => unlink(rootArtifact), 'not-observed');

      const finalPublications = publications;
      controller.dispose();
      const finalSnapshot = controller.snapshot;
      assert.equal(finalSnapshot?.observation.state, 'paused');
      assert.equal(activeWatchers.size, 0);
      assert.equal(disposedWatchers, createdWatchers);
      await writeFile(rootArtifact, '---\nstatus: final\n---\nAfter disposal\n');
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
