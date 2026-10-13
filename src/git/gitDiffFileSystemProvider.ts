import type * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const GIT_DIFF_SCHEME = 'gitlab-workspace-diff';

interface Comparison {
  before: vscode.Uri;
  after: vscode.Uri;
  opening: boolean;
  observed: boolean;
}

/** Immutable byte snapshots for VS Code's native text and binary Diff editors. */
export class GitDiffFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly files = new Map<string, { bytes: Uint8Array; created: number }>();
  private readonly comparisons = new Map<string, Comparison>();
  private readonly changes: vscode.EventEmitter<vscode.FileChangeEvent[]>;
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]>;
  private readonly registrations: vscode.Disposable[];

  constructor(private readonly host: typeof vscode) {
    this.changes = new host.EventEmitter<vscode.FileChangeEvent[]>();
    this.onDidChangeFile = this.changes.event;
    this.registrations = [
      host.workspace.registerFileSystemProvider(GIT_DIFF_SCHEME, this, { isCaseSensitive: true, isReadonly: true }),
      host.window.tabGroups.onDidChangeTabs(event => this.releaseUnused(event.closed))
    ];
  }

  createDiff(filename: string, beforeBytes: Uint8Array, afterBytes: Uint8Array): {
    before: vscode.Uri; after: vscode.Uri; opened(): void; dispose(): void;
  } {
    const id = randomUUID();
    const name = path.posix.basename(filename.replaceAll('\\', '/')) || 'file';
    const before = this.host.Uri.from({ scheme: GIT_DIFF_SCHEME, path: '/' + id + '/before/' + name });
    const after = this.host.Uri.from({ scheme: GIT_DIFF_SCHEME, path: '/' + id + '/after/' + name });
    const created = Date.now();
    this.files.set(before.toString(), { bytes: Uint8Array.from(beforeBytes), created });
    this.files.set(after.toString(), { bytes: Uint8Array.from(afterBytes), created });
    const comparison = { before, after, opening: true, observed: false };
    this.comparisons.set(id, comparison);
    return { before, after,
      opened: () => { comparison.opening = false; this.releaseUnused(); },
      dispose: () => this.release(id)
    };
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const file = this.requireFile(uri);
    return { type: this.host.FileType.File, ctime: file.created, mtime: file.created,
      size: file.bytes.byteLength, permissions: this.host.FilePermission.Readonly };
  }

  readFile(uri: vscode.Uri): Uint8Array { return Uint8Array.from(this.requireFile(uri).bytes); }
  watch(): vscode.Disposable { return new this.host.Disposable(() => undefined); }
  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    this.requireFile(uri); throw this.host.FileSystemError.FileNotADirectory(uri);
  }
  createDirectory(uri: vscode.Uri): never { throw this.host.FileSystemError.NoPermissions(uri); }
  writeFile(uri: vscode.Uri): never { throw this.host.FileSystemError.NoPermissions(uri); }
  delete(uri: vscode.Uri): never { throw this.host.FileSystemError.NoPermissions(uri); }
  rename(uri: vscode.Uri): never { throw this.host.FileSystemError.NoPermissions(uri); }

  dispose(): void {
    for (const registration of this.registrations) registration.dispose();
    this.files.clear(); this.comparisons.clear(); this.changes.dispose();
  }

  private requireFile(uri: vscode.Uri): { bytes: Uint8Array; created: number } {
    const file = this.files.get(uri.toString());
    if (!file) throw this.host.FileSystemError.FileNotFound(uri);
    return file;
  }

  private releaseUnused(closedTabs: readonly vscode.Tab[] = []): void {
    const used = new Set<string>();
    const closed = new Set<string>();
    const collect = (tab: vscode.Tab, target: Set<string>): void => {
      const input = tab.input as { original?: vscode.Uri; modified?: vscode.Uri; uri?: vscode.Uri } | undefined;
      for (const uri of [input?.original, input?.modified, input?.uri]) if (uri?.scheme === GIT_DIFF_SCHEME) target.add(uri.toString());
    };
    for (const group of this.host.window.tabGroups.all) for (const tab of group.tabs) {
      collect(tab, used);
    }
    for (const tab of closedTabs) collect(tab, closed);
    for (const [id, comparison] of this.comparisons) {
      const visible = used.has(comparison.before.toString()) || used.has(comparison.after.toString());
      if (visible || closed.has(comparison.before.toString()) || closed.has(comparison.after.toString())) comparison.observed = true;
      // The command response can precede the Extension Host's first tab notification.
      if (!comparison.opening && comparison.observed && !visible) this.release(id);
    }
  }

  private release(id: string): void {
    const comparison = this.comparisons.get(id);
    if (!comparison) return;
    this.files.delete(comparison.before.toString()); this.files.delete(comparison.after.toString());
    this.comparisons.delete(id);
  }
}
