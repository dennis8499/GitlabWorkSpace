import type * as vscode from 'vscode';
import { GitDiffFileSystemProvider } from './gitDiffFileSystemProvider';

/** One immutable document provider shared by local Git, remote MR and Wiki views. */
export class NativeDocuments implements vscode.Disposable {
  private readonly provider: GitDiffFileSystemProvider;
  constructor(private readonly host: typeof vscode) { this.provider = new GitDiffFileSystemProvider(host); }

  async openDiff(filename: string, before: Uint8Array, after: Uint8Array, title: string): Promise<void> {
    const comparison = this.provider.createDiff(filename, before, after);
    try {
      await this.host.commands.executeCommand('vscode.diff', comparison.before, comparison.after, title, { preview: false });
      comparison.opened();
    } catch (error) { comparison.dispose(); throw error; }
  }

  async openText(filename: string, bytes: Uint8Array, _title?: string): Promise<void> {
    const document = this.provider.createDocument(filename, bytes);
    try {
      await this.host.commands.executeCommand('vscode.open', document.uri, { preview: false });
      document.opened();
    } catch (error) { document.dispose(); throw error; }
  }

  dispose(): void { this.provider.dispose(); }
}

let shared: NativeDocuments | undefined;
export function getNativeDocuments(): NativeDocuments {
  // Bind the Extension Host only when a document is opened; pure services also run offline.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return shared ??= new NativeDocuments(require('vscode') as typeof vscode);
}
export function disposeNativeDocuments(): void { shared?.dispose(); shared = undefined; }
