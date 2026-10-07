import assert from 'node:assert/strict';
import test from 'node:test';
import { sameFilesystemPath } from './live-test-paths.mjs';

test('fixture paths on Windows compare case-insensitively after normalization', () => {
  assert.equal(sameFilesystemPath(
    'C:\\Users\\denni\\OneDrive\\Desktop\\新增資料夾\\GitlabWorkSpace\\.gitlab-workspace-validation\\workspaces\\ce19\\run-1234\\performance',
    'c:\\users\\DENNI\\OneDrive\\Desktop\\新增資料夾\\GitLabWorkSpace\\.gitlab-workspace-validation\\workspaces\\ce19\\run-1234\\performance',
    'win32'
  ), true);
});

test('fixture paths still reject a different run or checkout directory', () => {
  assert.equal(sameFilesystemPath(
    'C:\\validation\\workspaces\\ce19\\run-1234\\performance',
    'C:\\validation\\workspaces\\ce19\\run-5678\\performance',
    'win32'
  ), false);
  assert.equal(sameFilesystemPath('/validation/workspaces/ce19/run-1234/performance', '/validation/workspaces/ce19/run-5678/performance', 'linux'), false);
});
