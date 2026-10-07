import assert from 'node:assert/strict';
import * as vscode from 'vscode';

suite('GitLab Workspace extension activation', () => {
  test('activates one workspace navigation view and keeps existing commands available', async () => {
    const extension = vscode.extensions.getExtension('local-dev.gitlab-workspace');
    assert.ok(extension, 'the extension is installed in the Extension Host');
    await extension.activate();

    const quickActions = extension.packageJSON.contributes.views.gitlabWorkspace[0];
    assert.deepEqual(extension.packageJSON.contributes.views.gitlabWorkspace.map((view: { id: string }) => view.id), ['gitlabWorkspace.quickActions']);
    assert.equal(quickActions.id, 'gitlabWorkspace.quickActions');
    assert.equal(quickActions.type, 'webview');
    assert.equal(quickActions.visibility, 'visible');
    assert.ok(extension.packageJSON.activationEvents.includes('onView:gitlabWorkspace.quickActions'));
    assert.ok(!extension.packageJSON.activationEvents.includes('onView:gitlabWorkspace.repositories'));
    assert.ok(!extension.packageJSON.activationEvents.includes('onView:gitlabWorkspace.myIssues'));

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
      'gitlabWorkspace.openCloneMode',
      'gitlabWorkspace.openSaMode',
      'gitlabWorkspace.openDeveloperMode',
      'gitlabWorkspace.openReviewerMode',
      'gitlabWorkspace.openGitMode',
      'gitlabWorkspace.openRepository',
      'gitlabWorkspace.addAccount', 'gitlabWorkspace.switchAccount', 'gitlabWorkspace.removeAccount',
      'gitlabWorkspace.openAdmin', 'gitlabWorkspace.scanRepositories'
    ]) {
      assert.ok(commands.includes(command), `${command} is registered`);
    }
    const wikiGuideCommand = extension.packageJSON.contributes.commands.find((item: { command: string }) => item.command === 'gitlabWorkspace.openSaMode');
    assert.equal(wikiGuideCommand?.title, 'GitLab Workspace: Codebase LLM Wiki');
  });

});
