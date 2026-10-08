import assert from 'node:assert/strict';
import test from 'node:test';
import { sameFilesystemPath, createLiveTestProfile } from './live-test-paths.mjs';
import path from 'node:path';

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

test("portable cold sessions have distinct roots matching the environment override", () => {
  const root = path.resolve("isolated-test-profiles");
  const first = createLiveTestProfile(root, "ce19-1-1234", true);
  const next = createLiveTestProfile(root, "ce19-2-1234", true);
  assert.notEqual(first.userData, next.userData);
  assert.notEqual(first.environment.VSCODE_PORTABLE, next.environment.VSCODE_PORTABLE);
  assert.equal(first.userData, path.join(first.environment.VSCODE_PORTABLE, "user-data"));
  assert.equal(first.extensions, path.join(first.environment.VSCODE_PORTABLE, "extensions"));
  assert.equal(first.cleanupPaths.length, 1);
  assert.ok(path.relative(first.cleanupPaths[0], first.userData).startsWith("portable"));
});

test("normal profiles preserve CLI paths and unsafe profile IDs are rejected", () => {
  const root = path.resolve("isolated-test-profiles");
  const profile = createLiveTestProfile(root, "ce16-1-1234", false);
  assert.equal(profile.userData, path.join(root, "live-ce16-1-1234"));
  assert.equal(profile.extensions, path.join(root, "extensions-ce16-1-1234"));
  assert.deepEqual(profile.environment, {});
  assert.equal(profile.cleanupPaths.length, 2);
  assert.throws(() => createLiveTestProfile(root, "../outside", true), /Invalid isolated profile/);
});
