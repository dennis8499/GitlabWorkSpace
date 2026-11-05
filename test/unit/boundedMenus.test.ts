import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedMenuPosition } from '../../src/webview/boundedMenus';

test('a wrapped toolbar menu stays inside narrow workbench bounds', () => {
  const bounds = { left: 0, top: 90, right: 625, bottom: 630 };
  for (const anchor of [{ left: 8, top: 130, bottom: 160 }, { left: 600, top: 130, bottom: 160 }, { left: 200, top: 600, bottom: 625 }]) {
    const position = boundedMenuPosition(anchor, 185, 200, bounds);
    assert.ok(position.left >= bounds.left + 8); assert.ok(position.left + 185 <= bounds.right - 8);
    assert.ok(position.top >= bounds.top + 8); assert.ok(position.top + 200 <= bounds.bottom - 8);
  }
});
