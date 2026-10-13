import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';

interface DiffTestApi {
  getGitRepositoryState(): Promise<{ repositories: Array<{ id: string; path: string }> }>;
  openNativeGitDiffForTesting?(id: string, filename: string, staged: boolean): Promise<void>;
}

suite('Native readonly Git Diff snapshots', function () {
  this.timeout(45_000);
  test('preserves text and binary bytes and releases each snapshot after the last native tab closes', async function () {
    const extension = vscode.extensions.getExtension('local-dev.gitlab-workspace');
    assert.ok(extension);
    const api = await extension.activate() as DiffTestApi;
    // Historical baseline artifacts predate the snapshot provider and test API.
    if (!api.openNativeGitDiffForTesting) this.skip();
    const nativeExtension = vscode.extensions.getExtension('vscode.git');
    assert.ok(nativeExtension);
    const native = (await nativeExtension.activate()).getAPI(1) as { openRepository(root: vscode.Uri): Promise<{ status(): Promise<void> } | null> };
    const ownedParent = process.env.GITLAB_WORKSPACE_TEST_TMP
      ?? (process.env.GLW_LIVE_WORKSPACE_ROOT ? path.dirname(process.env.GLW_LIVE_WORKSPACE_ROOT) : os.tmpdir());
    const root = await mkdtemp(path.join(ownedParent, 'native-diff-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'ignore' });
    git('init', '-b', 'main'); git('config', 'user.name', 'Diff Validation'); git('config', 'user.email', 'diff-validation@localhost');
    git('config', 'core.autocrlf', 'false'); git('config', 'commit.gpgSign', 'false');
    const beforeText = Buffer.from('export const label = "原始";\r\n');
    const afterText = Buffer.from('export const label = "更新";\r\n');
    const binary = Buffer.from([0, 255, 128, 13, 10]);
    await writeFile(path.join(root, 'service.ts'), beforeText);
    await writeFile(path.join(root, 'data.bin'), binary);
    git('add', '.'); git('commit', '-m', 'Initial Diff fixture');
    await writeFile(path.join(root, 'service.ts'), afterText);
    await writeFile(path.join(root, 'data.bin'), Buffer.from([0, 254, 128, 10]));
    const providerTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
      tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === 'gitlab-workspace-diff');
    const originalWorkspace = (vscode.workspace.workspaceFolders ?? []).map(folder => ({ uri: folder.uri, name: folder.name }));
    const added = new Promise<void>(resolve => {
      const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => { listener.dispose(); resolve(); });
    });
    // VS Code 1.90 does not open a Repo outside the workspace under its default
    // parent-repository policy. Give this fixture the same boundary as a real user Repo.
    assert.equal(vscode.workspace.updateWorkspaceFolders(originalWorkspace.length, 0,
      { uri: vscode.Uri.file(root), name: 'Native Diff fixture' }), true);
    await added;
    try {
      const repository = await native.openRepository(vscode.Uri.file(root));
      assert.ok(repository); await repository.status();
      let id: string | undefined;
      for (let attempt = 0; attempt < 100 && !id; attempt++) {
        id = (await api.getGitRepositoryState()).repositories.find(repo => path.resolve(repo.path).toLowerCase() === path.resolve(root).toLowerCase())?.id;
        if (!id) await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(id, 'VS Code registers the isolated Repo');
      await api.openNativeGitDiffForTesting!(id, 'service.ts', false);
      let tab = providerTabs().find(tab => (tab.input as vscode.TabInputTextDiff).modified.path.endsWith('/service.ts'));
      for (let attempt = 0; attempt < 50 && !tab; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20)); tab = providerTabs().find(tab => (tab.input as vscode.TabInputTextDiff).modified.path.endsWith('/service.ts'));
      }
      assert.ok(tab, 'the native Diff tab uses the snapshot filesystem');
      const input = tab.input as vscode.TabInputTextDiff;
      assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(input.original)), beforeText);
      assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(input.modified)), afterText);
      assert.equal((await vscode.workspace.fs.stat(input.modified)).permissions, vscode.FilePermission.Readonly);
      await assert.rejects(async () => vscode.workspace.fs.writeFile(input.modified, Buffer.from('changed')));
      await vscode.window.tabGroups.close(tab);
      let released = false;
      for (let attempt = 0; attempt < 50 && !released; attempt++) {
        released = await vscode.workspace.fs.stat(input.original).then(() => false, () => true);
        if (!released) await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(released, true, 'closing the final native tab releases both snapshots');
      await assert.rejects(async () => vscode.workspace.fs.readFile(input.modified));
      assert.deepEqual(await readFile(path.join(root, 'service.ts')), afterText, 'the original working file is unchanged');
      // Staged binary snapshots retain raw bytes even when the editor cannot render them as text.
      await api.openNativeGitDiffForTesting!(id, 'data.bin', true);
      const binaryTab = providerTabs().find(tab => (tab.input as vscode.TabInputTextDiff).original.path.endsWith('/data.bin'));
      assert.ok(binaryTab);
      assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile((binaryTab.input as vscode.TabInputTextDiff).original)), binary);
    } finally {
      await vscode.window.tabGroups.close(providerTabs());
      const restored = new Promise<void>(resolve => {
        const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => { listener.dispose(); resolve(); });
      });
      assert.equal(vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length ?? 0, ...originalWorkspace), true);
      await restored;
      // The wrapper owns the temporary parent; leave removal until VS Code releases Git watchers.
    }
  });
});
