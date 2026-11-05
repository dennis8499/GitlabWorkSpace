import assert from 'node:assert/strict';
import * as vscode from 'vscode';

suite('GitLab Workspace extension activation', () => {
  test('activates native repository and work views and keeps existing commands available', async () => {
    const extension = vscode.extensions.getExtension('local-dev.gitlab-workspace');
    assert.ok(extension, 'the extension is installed in the Extension Host');
    await extension.activate();
    assert.equal(extension.packageJSON.capabilities.untrustedWorkspaces.supported, false);
    assert.equal(extension.packageJSON.capabilities.virtualWorkspaces.supported, 'limited');

    const views = extension.packageJSON.contributes.views.gitlabWorkspace;
    assert.deepEqual(views.map((view: { id: string }) => view.id), ['gitlabWorkspace.repositories', 'gitlabWorkspace.myWork']);
    assert.ok(views.every((view: { type?: string }) => view.type !== 'webview'));
    for (const view of views) assert.ok(extension.packageJSON.activationEvents.includes('onView:' + view.id));
    assert.ok(!extension.packageJSON.activationEvents.includes('onView:gitlabWorkspace.quickActions'));

    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      'gitlabWorkspace.connect',
      'gitlabWorkspace.selectGroup',
      'gitlabWorkspace.refresh',
      'gitlabWorkspace.cloneRepositories',
      'gitlabWorkspace.cloneAllRepositories',
      'gitlabWorkspace.cloneSelectedRepositories',
      'gitlabWorkspace.syncLocalDefaultBranches',
      'gitlabWorkspace.createIssue',
      'gitlabWorkspace.disconnect',
      'gitlabWorkspace.openIssue',
      'gitlabWorkspace.openWorkspace',
      'gitlabWorkspace.openSettings', 'gitlabWorkspace.openTools', 'gitlabWorkspace.selectWorkflow',
      'gitlabWorkspace.refreshMyWork', 'gitlabWorkspace.refreshRepositories', 'gitlabWorkspace.findMyWork', 'gitlabWorkspace.findRepositories',
      'gitlabWorkspace.openCloneMode',
      'gitlabWorkspace.openSaMode',
      'gitlabWorkspace.openBmadMode',
      'gitlabWorkspace.openDeveloperMode',
      'gitlabWorkspace.openReviewerMode',
      'gitlabWorkspace.openGitMode',
      'gitlabWorkspace.openRepository',
      'gitlabWorkspace.addAccount', 'gitlabWorkspace.switchAccount', 'gitlabWorkspace.removeAccount',
      'gitlabWorkspace.openAdmin', 'gitlabWorkspace.showLogs', 'gitlabWorkspace.scanRepositories'
    ]) {
      assert.ok(commands.includes(command), `${command} is registered`);
    }
    const wikiGuideCommand = extension.packageJSON.contributes.commands.find((item: { command: string }) => item.command === 'gitlabWorkspace.openSaMode');
    assert.equal(wikiGuideCommand?.title, 'Skills 功能指引');
    const showLogsCommand = extension.packageJSON.contributes.commands.find((item: { command: string }) => item.command === 'gitlabWorkspace.showLogs');
    assert.equal(showLogsCommand?.title, '開啟 Log');
    const settingsCommand = extension.packageJSON.contributes.commands.find((item: { command: string }) => item.command === 'gitlabWorkspace.openSettings');
    assert.equal(settingsCommand?.title, '設定');
    assert.ok(extension.packageJSON.activationEvents.includes('onCommand:gitlabWorkspace.openSettings'));
    assert.ok(extension.packageJSON.activationEvents.includes('onCommand:gitlabWorkspace.showLogs'));
    assert.ok(extension.packageJSON.contributes.menus.commandPalette.some((item: { command: string; when?: string }) =>
      item.command === 'gitlabWorkspace.openAdmin' && item.when === 'false'));
  });

  test('native views run in the real Host while the Dashboard is closed', async () => {
    const extension = vscode.extensions.getExtension('local-dev.gitlab-workspace')!;
    const api = await extension.activate() as { getNavigationForTesting(): import('../../src/navigationViews').NavigationViews;
      getWorkspaceForTesting(): import('../../src/workspace/workspacePanel').WorkspacePanel };
    const navigation = api.getNavigationForTesting(), host = api.getWorkspaceForTesting();
    assert.ok(navigation.repositoryView); assert.ok(navigation.workView);
    await vscode.commands.executeCommand('gitlabWorkspace.repositories.focus');
    assert.equal(navigation.repositoryView.visible, true);
    const before = host.getNavigationSnapshot();
    navigation.repositories.getChildren(); navigation.repositories.getChildren();
    assert.equal(host.getNavigationSnapshot().scope, before.scope);
    const node: import('../../src/navigationViews').WorkNode = { kind: 'issue', issue: { project_id: 1, iid: 7, title: 'Host navigation test', state: 'opened' } as any, scope: before.scope };
    const item = navigation.work.getTreeItem(node);
    assert.ok(item.iconPath instanceof vscode.ThemeIcon);
    assert.equal(item.command?.command, 'gitlabWorkspace.openIssue');
    await assert.rejects(host.openIssueFromCommand(node.issue, 'obsolete-account-scope'), /帳號或 Group/);
  });

});
