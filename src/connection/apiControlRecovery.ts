import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { GitLabNetworkError } from '../api/gitLabNetworkGate';
import { networkRuntimeRoot } from '../api/localNetworkLease';
import type { NotificationTarget } from '../notifications/notificationProtocol';

const exec = promisify(execFile);
const quote = (value: string): string => "'" + value.replaceAll("'", "''") + "'";
const encoded = (value: string): string => Buffer.from(value, 'utf16le').toString('base64');
const windowsArgument = (value: string): string => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
const powershell = (): string => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export interface ApiControlInspection {
  recoveryId: string;
  leasePath: string;
  status: 'Missing' | 'Empty' | 'NotEmpty';
  entries: string[];
}
export type ApiControlLaunch = ApiControlInspection | { status: 'Launched'; leasePath: string };
type Execute = (source: string) => Promise<string>;

async function executePowerShell(source: string): Promise<string> {
  const { stdout } = await exec(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded(
    "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); " + source)],
  { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
  return stdout;
}

/** Paths and process arguments stay in the local Host; views receive opaque IDs only. */
export class ApiControlRecovery {
  private readonly root: string;
  private readonly platform: NodeJS.Platform;
  private readonly execute: Execute;
  private readonly targets = new Map<string, string>();
  private readonly launches = new Map<string, Promise<ApiControlLaunch>>();

  constructor(private readonly options: { scriptPath: string; runtimeRoot?: string; platform?: NodeJS.Platform; execute?: Execute }) {
    this.root = path.resolve(options.runtimeRoot ?? networkRuntimeRoot());
    this.platform = options.platform ?? process.platform;
    this.execute = options.execute ?? executePowerShell;
  }

  capture(error: unknown): Extract<NotificationTarget, { kind: 'networkRecovery' }> | undefined {
    if (this.platform !== 'win32' || !(error instanceof GitLabNetworkError)) return;
    const diagnostic = error.diagnostics;
    if (diagnostic?.phase !== 'admission' || diagnostic.code !== 'metadata-missing' || diagnostic.requestStarted !== false ||
        path.resolve(diagnostic.runtimePath).toLowerCase() !== this.root.toLowerCase() || !this.validLease(diagnostic.leasePath)) return;
    return { kind: 'networkRecovery', recoveryId: this.remember(diagnostic.leasePath) };
  }

  async inspect(recoveryId?: string): Promise<ApiControlInspection[]> {
    this.assertWindows();
    const target = recoveryId === undefined ? undefined : this.target(recoveryId);
    const stdout = await this.execute(`& ${quote(this.options.scriptPath)} -RuntimeRoot ${quote(this.root)}${target ? ' -LeasePath ' + quote(target) : ''}`);
    if (!stdout.trim()) return [];
    const parsed: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ''));
    const values: unknown[] = Array.isArray(parsed) ? parsed : parsed === null ? [] : [parsed];
    return values.map(value => {
      const item = value as { LeasePath?: unknown; Status?: unknown; Entries?: unknown } | null;
      if (!item || typeof item.LeasePath !== 'string' || !this.validLease(item.LeasePath) ||
          target && path.resolve(item.LeasePath).toLowerCase() !== target.toLowerCase() ||
          !['Missing', 'Empty', 'NotEmpty'].includes(String(item.Status)) || !Array.isArray(item.Entries) ||
          item.Entries.some(entry => typeof entry !== 'string')) throw new Error('本機連線檢查傳回無效的結果；未啟動復原。');
      return { recoveryId: this.remember(item.LeasePath), leasePath: item.LeasePath,
        status: item.Status as ApiControlInspection['status'], entries: item.Entries as string[] };
    });
  }

  launch(recoveryId: string): Promise<ApiControlLaunch> {
    this.assertWindows();
    const target = this.target(recoveryId);
    const existing = this.launches.get(target);
    if (existing) return existing;
    const launch = this.launchChecked(recoveryId);
    this.launches.set(target, launch);
    void launch.finally(() => { if (this.launches.get(target) === launch) this.launches.delete(target); }).catch(() => undefined);
    return launch;
  }

  private async launchChecked(recoveryId: string): Promise<ApiControlLaunch> {
    const inspection = (await this.inspect(recoveryId))[0];
    if (!inspection) throw new Error('本機連線檢查未傳回指定鎖的結果；請重新檢查。');
    if (inspection.status !== 'Empty') return inspection;
    // The visible process has its own console and is not tied to an integrated terminal.
    // -File treats values as literal arguments. Avoid a second encoded command,
    // which unnecessarily expands long Windows paths and can fail at process creation.
    const args = ['-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', this.options.scriptPath,
      '-RuntimeRoot', this.root, '-LeasePath', inspection.leasePath, '-Interactive'].map(windowsArgument).join(' ');
    await this.execute(`Start-Process -FilePath ${quote(powershell())} -WindowStyle Normal -ArgumentList ${quote(args)}`);
    return { status: 'Launched', leasePath: inspection.leasePath };
  }

  private validLease(value: unknown): value is string {
    if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value) || !path.isAbsolute(this.root) || this.root.startsWith('\\\\')) return false;
    return /^api[\\/][a-f0-9]{64}[\\/]control\.lock$/i.test(path.relative(this.root, path.resolve(value)));
  }
  private remember(target: string): string {
    const normalized = path.resolve(target);
    for (const [id, existing] of this.targets) if (existing.toLowerCase() === normalized.toLowerCase()) return id;
    const id = randomUUID(); this.targets.set(id, normalized);
    if (this.targets.size > 128) this.targets.delete(this.targets.keys().next().value!);
    return id;
  }
  private target(id: string): string {
    const target = this.targets.get(id);
    if (!target || !this.validLease(target)) throw new Error('復原目標已失效；請執行「修復本機 GitLab 連線」重新檢查。');
    return target;
  }
  private assertWindows(): void {
    if (this.platform !== 'win32') throw new Error('獨立連線復原工具目前僅支援本機 Windows；請依本機網路負載控制文件檢查。');
  }
}
