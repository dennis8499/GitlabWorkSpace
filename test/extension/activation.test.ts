import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { GitLabGroup, GitLabIssue, GitLabProject } from '../../src/api/types';
import type { GitLabSession } from '../../src/connection/session';
import { CloneOperationGate, IssueProvider, RepositoryProvider, resolveCloneCandidates } from '../../src/extension';

suite('GitLab Workspace extension activation', () => {
  test('activates its native views and commands without prompting for a token', async () => {
    const extension = vscode.extensions.getExtension('local-dev.gitlab-workspace');
    assert.ok(extension, 'the extension is installed in the Extension Host');
    await extension.activate();

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
      'gitlabWorkspace.openIssue'
    ]) {
      assert.ok(commands.includes(command), `${command} is registered`);
    }
  });

  test('allows only one clone operation at a time', () => {
    const gate = new CloneOperationGate();
    assert.equal(gate.tryStart(), true);
    assert.equal(gate.tryStart(), false, 'a repeated command cannot start another batch');
    assert.equal(gate.inProgress, true);
    gate.finish();
    assert.equal(gate.tryStart(), true, 'a later batch can start after the first finishes');
    gate.finish();
  });

  test('lists member groups in the Repositories tree and expands the selected group to projects', async () => {
    const selected: GitLabGroup = { id: 1, name: 'Alpha', full_path: 'team/alpha', web_url: '' };
    const other: GitLabGroup = { id: 2, name: 'Beta', full_path: 'team/beta', web_url: '' };
    const project: GitLabProject = {
      id: 10,
      name: 'service',
      path: 'service',
      path_with_namespace: 'team/alpha/service',
      web_url: 'https://gitlab.example.test/team/alpha/service',
      http_url_to_repo: 'https://gitlab.example.test/team/alpha/service.git'
    };
    const unselectedProject: GitLabProject = {
      id: 11,
      name: 'worker',
      path: 'worker',
      path_with_namespace: 'team/alpha/worker',
      web_url: 'https://gitlab.example.test/team/alpha/worker',
      http_url_to_repo: 'https://gitlab.example.test/team/alpha/worker.git'
    };
    let visibleProjects = [project, unselectedProject];
    const client = {
      async listGroups() { return [selected, other]; },
      async listGroupProjects(groupId: number) { return groupId === selected.id ? visibleProjects : []; }
    };
    let activeGroup = selected;
    const session = {
      get selectedGroup() { return activeGroup; },
      async getClient() { return client; }
    } as unknown as GitLabSession;
    const provider = new RepositoryProvider(session);
    try {
      const groups = await provider.getChildren();
      assert.deepEqual(groups.map((item) => item.label), ['team/alpha', 'team/beta']);
      assert.equal(groups[0].description, '目前選取');
      assert.equal(groups[0].collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
      const repositoryItems = await provider.getChildren(groups[0]);
      assert.deepEqual(repositoryItems.map((item) => item.label), ['service', 'worker']);
      assert.equal(repositoryItems[0].command, undefined, 'clicking a project row does not start a clone');
      assert.equal(repositoryItems[0].checkboxState, vscode.TreeItemCheckboxState.Unchecked);
      assert.deepEqual(resolveCloneCandidates('selected', selected.id, [project, unselectedProject], provider), []);

      provider.updateCheckboxState([[repositoryItems[0], vscode.TreeItemCheckboxState.Checked]]);
      assert.equal(repositoryItems[0].checkboxState, vscode.TreeItemCheckboxState.Checked);
      assert.deepEqual(provider.getCheckedProjects(selected.id, [project]), [project]);
      assert.deepEqual(resolveCloneCandidates('all', selected.id, [project, unselectedProject], provider), [project, unselectedProject]);
      assert.deepEqual(resolveCloneCandidates('selected', selected.id, [project], provider), [project]);

      provider.ensureCheckedProjects(selected.id, [project, unselectedProject]);
      provider.removeCheckedProjects(selected.id, [project]);
      assert.deepEqual(provider.getCheckedProjects(selected.id, [project, unselectedProject]), [unselectedProject], 'completed projects are unchecked while remaining projects stay checked');
      visibleProjects = [project];
      await provider.getChildren(groups[0]);
      assert.deepEqual(provider.getCheckedProjects(selected.id, [project]), [], 'refresh removes projects that left the group');
      visibleProjects = [project, unselectedProject];
      const refreshedItems = await provider.getChildren(groups[0]);
      assert.equal(refreshedItems[0].checkboxState, vscode.TreeItemCheckboxState.Unchecked);

      provider.updateCheckboxState([[refreshedItems[0], vscode.TreeItemCheckboxState.Checked]]);
      activeGroup = other;
      provider.setSelectedGroup(other.id);
      assert.deepEqual(provider.getCheckedProjects(other.id, [project]), [], 'changing groups clears prior checks');
      assert.deepEqual(resolveCloneCandidates('selected', other.id, [project], provider), []);
    } finally {
      provider.dispose();
    }
  });

  test('groups assigned issues into opened and closed sections', async () => {
    const selected: GitLabGroup = { id: 1, name: 'Alpha', full_path: 'team/alpha', web_url: '' };
    const projects: GitLabProject[] = [{
      id: 10,
      name: 'service',
      path: 'service',
      path_with_namespace: 'team/alpha/service',
      web_url: 'https://gitlab.example.test/team/alpha/service',
      http_url_to_repo: 'https://gitlab.example.test/team/alpha/service.git'
    }];
    const issues: GitLabIssue[] = [
      { id: 101, iid: 1, project_id: 10, title: 'Open regression', state: 'opened', web_url: 'https://gitlab.example.test/team/alpha/service/-/issues/1' },
      { id: 102, iid: 2, project_id: 10, title: 'Closed task', state: 'closed', web_url: 'https://gitlab.example.test/team/alpha/service/-/issues/2' }
    ];
    const client = {
      async listGroupProjects() { return projects; },
      async listAssignedGroupIssues() { return issues; }
    };
    const session = {
      selectedGroup: selected,
      async getClient() { return client; }
    } as unknown as GitLabSession;
    const provider = new IssueProvider(session);
    try {
      const sections = await provider.getChildren();
      assert.deepEqual(sections.map((item) => item.label), ['team/alpha', '未結案 (1)', '已結案 (1)']);

      const opened = await provider.getChildren(sections[1]);
      const closed = await provider.getChildren(sections[2]);
      assert.deepEqual(opened.map((item) => item.label), ['#1 Open regression']);
      assert.deepEqual(closed.map((item) => item.label), ['#2 Closed task']);
    } finally {
      provider.dispose();
    }
  });
});
