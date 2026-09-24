import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { GitLabGroup, GitLabIssue, GitLabProject } from '../../src/api/types';
import type { GitLabSession } from '../../src/connection/session';
import { IssueProvider, RepositoryProvider } from '../../src/extension';

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
      'gitlabWorkspace.createIssue',
      'gitlabWorkspace.disconnect',
      'gitlabWorkspace.openIssue'
    ]) {
      assert.ok(commands.includes(command), `${command} is registered`);
    }
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
    const client = {
      async listGroups() { return [selected, other]; },
      async listGroupProjects(groupId: number) { return groupId === selected.id ? [project] : []; }
    };
    const session = {
      selectedGroup: selected,
      async getClient() { return client; }
    } as unknown as GitLabSession;
    const provider = new RepositoryProvider(session);
    try {
      const groups = await provider.getChildren();
      assert.deepEqual(groups.map((item) => item.label), ['team/alpha', 'team/beta']);
      assert.equal(groups[0].description, 'selected');
      assert.equal(groups[0].collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
      const repositories = await provider.getChildren(groups[0]);
      assert.deepEqual(repositories.map((item) => item.label), ['service']);
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
      assert.deepEqual(sections.map((item) => item.label), ['team/alpha', 'Opened (1)', 'Closed (1)']);

      const opened = await provider.getChildren(sections[1]);
      const closed = await provider.getChildren(sections[2]);
      assert.deepEqual(opened.map((item) => item.label), ['#1 Open regression']);
      assert.deepEqual(closed.map((item) => item.label), ['#2 Closed task']);
    } finally {
      provider.dispose();
    }
  });
});
