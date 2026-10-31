"""Isolated VSIX offline startup, panel lifecycle and process counter capture (Windows)."""
import argparse
import base64
import ctypes
from ctypes import wintypes
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
EVIDENCE = HERE / 'evidence' / 'performance-native'
K = ctypes.WinDLL('kernel32', use_last_error=True)
PS = ctypes.WinDLL('psapi', use_last_error=True)

class ENTRY(ctypes.Structure):
    _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD), ('pid', wintypes.DWORD),
                ('heap', ctypes.c_size_t), ('module', wintypes.DWORD), ('threads', wintypes.DWORD),
                ('ppid', wintypes.DWORD), ('priority', wintypes.LONG), ('flags', wintypes.DWORD),
                ('exe', wintypes.WCHAR * 260)]

class MEMORY(ctypes.Structure):
    _fields_ = [('cb', wintypes.DWORD), ('faults', wintypes.DWORD)] + [(n, ctypes.c_size_t) for n in
        ('peakWorkingSet', 'workingSet', 'quotaPeakPaged', 'quotaPaged', 'quotaPeakNonPaged', 'quotaNonPaged',
         'pagefile', 'peakPagefile', 'privateBytes')]

class IO(ctypes.Structure):
    _fields_ = [(n, ctypes.c_ulonglong) for n in
                ('readOps', 'writeOps', 'otherOps', 'readBytes', 'writeBytes', 'otherBytes')]

K.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
K.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
K.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ENTRY)]
K.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ENTRY)]
K.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
K.OpenProcess.restype = wintypes.HANDLE
K.CloseHandle.argtypes = [wintypes.HANDLE]
K.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
K.GetProcessIoCounters.argtypes = [wintypes.HANDLE, ctypes.POINTER(IO)]
K.GetProcessHandleCount.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
PS.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(MEMORY), wintypes.DWORD]

def filetime(v):
    return ((v.dwHighDateTime << 32) | v.dwLowDateTime) / 10000000

def tree(root):
    snap = K.CreateToolhelp32Snapshot(2, 0)
    if snap == wintypes.HANDLE(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    entries = []
    try:
        entry = ENTRY()
        entry.dwSize = ctypes.sizeof(ENTRY)
        ok = K.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            entries.append({'pid': entry.pid, 'ppid': entry.ppid, 'exe': entry.exe, 'threads': entry.threads})
            ok = K.Process32NextW(snap, ctypes.byref(entry))
    finally:
        K.CloseHandle(snap)
    children = {root}
    for _ in range(len(entries)):
        old = len(children)
        children.update(e['pid'] for e in entries if e['ppid'] in children)
        if len(children) == old:
            break
    return [e for e in entries if e['pid'] in children]

def counters(entry, types, host_pid):
    entry = dict(entry)
    pid = entry['pid']
    entry['kind'] = 'extensionHost' if pid == host_pid else ('git' if entry['exe'].lower() in ('git.exe', 'git-remote-http.exe', 'git-remote-https.exe') else types.get(pid, 'unclassified'))
    handle = K.OpenProcess(0x1000 | 0x0010, False, pid) or K.OpenProcess(0x1000, False, pid)
    if not handle:
        entry['error'] = f'OpenProcess error {ctypes.get_last_error()}'
        return entry
    try:
        a, b, kernel, user = [wintypes.FILETIME() for _ in range(4)]
        if K.GetProcessTimes(handle, ctypes.byref(a), ctypes.byref(b), ctypes.byref(kernel), ctypes.byref(user)):
            entry['cpuSeconds'] = filetime(kernel) + filetime(user)
        memory = MEMORY()
        memory.cb = ctypes.sizeof(memory)
        if PS.GetProcessMemoryInfo(handle, ctypes.byref(memory), memory.cb):
            entry.update(workingSet=memory.workingSet, privateBytes=memory.privateBytes)
        io = IO()
        if K.GetProcessIoCounters(handle, ctypes.byref(io)):
            entry['io'] = {n: getattr(io, n) for n, _ in IO._fields_}
        count = wintypes.DWORD()
        if K.GetProcessHandleCount(handle, ctypes.byref(count)):
            entry['handles'] = count.value
    finally:
        K.CloseHandle(handle)
    return entry

class CDP:
    def __init__(self, port):
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/json/version', timeout=1) as response:
            url = json.load(response)['webSocketDebuggerUrl']
        path = '/' + url.split('/', 3)[3]
        self.sock = socket.create_connection(('127.0.0.1', port), timeout=2)
        self.sock.settimeout(2)
        key = base64.b64encode(os.urandom(16)).decode('ascii')
        request = (f'GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n')
        self.sock.sendall(request.encode('ascii'))
        response = b''
        while not response.endswith(b'\r\n\r\n'):
            response += self.sock.recv(1)
        if b' 101 ' not in response:
            raise RuntimeError('CDP WebSocket handshake failed')
        self.id = 0
    def exact(self, count):
        value = b''
        while len(value) < count:
            chunk = self.sock.recv(count - len(value))
            if not chunk:
                raise EOFError('CDP closed')
            value += chunk
        return value
    def processes(self):
        self.id += 1
        payload = json.dumps({'id': self.id, 'method': 'SystemInfo.getProcessInfo'}).encode()
        mask = os.urandom(4)
        header = bytes([0x81, 0x80 | len(payload)])
        self.sock.sendall(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
        while True:
            first, second = self.exact(2)
            size = second & 127
            if size == 126:
                size = struct.unpack('!H', self.exact(2))[0]
            elif size == 127:
                size = struct.unpack('!Q', self.exact(8))[0]
            data = self.exact(size)
            if first & 15 == 8:
                raise EOFError('CDP closed')
            if first & 15 != 1:
                continue
            obj = json.loads(data)
            if obj.get('id') == self.id:
                if 'error' in obj:
                    raise RuntimeError(str(obj['error']))
                return {item['id']: item['type'] for item in obj['result'].get('processInfo', [])}
    def close(self):
        self.sock.close()

def write_json(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

def sample_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]

def receipt_disk_snapshot(profile):
    folder = profile / 'User' / 'globalStorage' / 'local-dev.gitlab-workspace' / 'operation-receipts'
    if not folder.is_dir():
        return {'exists': False, 'files': 0, 'bytes': 0}
    files = [item for item in folder.glob('*.jsonl') if item.is_file()]
    return {'exists': True, 'files': len(files), 'bytes': sum(item.stat().st_size for item in files)}

def run(args):
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    artifact = (args.artifact or ROOT / 'dist' / 'gitlab-workspace-0.37.3.vsix').resolve()
    executable = Path(os.environ['USERPROFILE']) / 'AppData/Local/Programs/Microsoft VS Code/Code.exe'
    artifact_sha = hashlib.sha256(artifact.read_bytes()).hexdigest()
    # VSIX dependencies include deep paths: keep disposable profiles close to
    # the OS temp root to avoid Windows' legacy 260-character path limit.
    temp_parent = Path(tempfile.gettempdir()).resolve()
    test_root = Path(tempfile.mkdtemp(prefix='glw-audit-native-', dir=temp_parent)).resolve()
    ext_dir = test_root / 'extensions'
    installed = ext_dir / 'local-dev.gitlab-workspace-0.37.3'
    installed.mkdir(parents=True)
    with zipfile.ZipFile(artifact) as z:
        for info in z.infolist():
            if not info.filename.startswith('extension/') or info.is_dir():
                continue
            rel = Path(info.filename[len('extension/'):])
            if rel.is_absolute() or '..' in rel.parts:
                raise ValueError('Invalid archive path')
            target = installed / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(z.read(info))
    fixture = test_root / 'workspace'
    fixture.mkdir()
    summary = {'schema': 'GitLabWorkspaceOfflineNativeResourceProbe/v1', 'artifactSha256': artifact_sha,
               'artifact': str(artifact.relative_to(ROOT)), 'method': 'Offline, installed VSIX in isolated profile; command return is not rendered readiness',
               'rounds': [], 'limits': ['No GitLab account, data, timer or graph activity', 'Worker threads are not separately attributable by process counters',
                                       'I/O counters are process operations, not actual disk bytes', 'Initial extraction precedes all measured rounds']}
    for index in range(1, args.rounds + 1):
        long_run = args.long and index == args.rounds
        profile = test_root / f'user-{index}'
        settings_dir = profile / 'User'
        settings_dir.mkdir(parents=True)
        write_json(settings_dir / 'settings.json', {'security.workspace.trust.enabled': False, 'git.autofetch': False,
                   'extensions.autoCheckUpdates': False, 'extensions.autoUpdate': False, 'update.mode': 'none',
                   'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off'})
        event_file = EVIDENCE / f'events-{index:02d}.jsonl'
        sample_file = EVIDENCE / f'samples-{index:02d}.jsonl'
        env = dict(os.environ)
        env.pop('ELECTRON_RUN_AS_NODE', None)
        env.pop('VSCODE_PORTABLE', None)
        for key in list(env):
            if key.startswith('GLW_CE') and key.endswith('_TOKEN'):
                env.pop(key)
        env.update(GLW_AUDIT_EVENTS=str(event_file), GLW_AUDIT_LONG='1' if long_run else '0')
        port = sample_port()
        cmd = [str(executable), str(fixture), f'--user-data-dir={profile}', f'--extensions-dir={ext_dir}',
               f'--extensionDevelopmentPath={HERE / "performance-probe"}', f'--remote-debugging-port={port}',
               '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust']
        start_wall = time.time()
        start_mono = time.monotonic()
        with (EVIDENCE / f'vscode-{index:02d}.log').open('w', encoding='utf-8') as output, sample_file.open('w', encoding='utf-8') as samples:
            process = subprocess.Popen(cmd, cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT)
            print(f'round {index}/{args.rounds} pid={process.pid} long={long_run}', flush=True)
            host_pid, cdp, types, cdp_error = None, None, {}, None
            receipt_snapshots = {}
            max_time = 750 if long_run else 90
            while process.poll() is None and time.monotonic() - start_mono < max_time:
                if event_file.exists():
                    for line in event_file.read_text(encoding='utf-8').splitlines():
                        try:
                            data = json.loads(line)
                        except json.JSONDecodeError:
                            # A synchronous append in the extension host may be in progress.
                            continue
                        if data.get('hostPid'):
                            host_pid = data['hostPid']
                        event = data.get('event')
                        if event in ('workspace-command-returned', 'idle-start', 'idle-complete') and event not in receipt_snapshots:
                            receipt_snapshots[event] = receipt_disk_snapshot(profile)
                if cdp is None:
                    try:
                        cdp = CDP(port)
                    except Exception as exc:
                        cdp_error = str(exc)
                if cdp is not None and (not types or int(time.monotonic() - start_mono) % 10 == 0):
                    try:
                        types = cdp.processes()
                    except Exception as exc:
                        cdp_error = str(exc)
                        cdp.close()
                        cdp = None
                try:
                    processes = [counters(entry, types, host_pid) for entry in tree(process.pid)]
                    samples.write(json.dumps({'at': time.time(), 'elapsedSeconds': time.monotonic() - start_mono,
                                              'processes': processes}, ensure_ascii=False) + '\n')
                    samples.flush()
                except Exception as exc:
                    samples.write(json.dumps({'at': time.time(), 'error': str(exc)}) + '\n')
                time.sleep(1)
            if cdp:
                cdp.close()
            timed_out = process.poll() is None
            if timed_out:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            events = [json.loads(line) for line in event_file.read_text(encoding='utf-8').splitlines()] if event_file.exists() else []
            command_event = next((e for e in events if e['event'] == 'workspace-command-returned'), None)
            tab_event = next((e for e in events if e['event'] == 'workspace-tab-active'), None)
            completed = any(e['event'] == 'probe-complete' for e in events)
            row = {'round': index, 'long': long_run, 'pid': process.pid, 'exitCode': process.returncode,
                   'timedOut': timed_out, 'completed': completed, 'cdpError': cdp_error,
                   'startupToCommandReturnedMs': round(command_event['at'] - start_wall * 1000, 2) if command_event else None,
                   'startupToActiveTabMs': round(tab_event['at'] - start_wall * 1000, 2) if tab_event else None,
                   'workspaceCommandDurationMs': command_event['elapsedMs'] if command_event else None,
                   'events': str(event_file.relative_to(HERE)), 'samples': str(sample_file.relative_to(HERE)),
                   'receiptSnapshots': {**receipt_snapshots, 'afterProcessExit': receipt_disk_snapshot(profile)}}
            summary['rounds'].append(row)
            write_json(EVIDENCE / 'summary.json', summary)
            print(json.dumps(row, ensure_ascii=False), flush=True)
    # Only this script's freshly created run-* tree is eligible for cleanup.
    resolved = test_root.resolve()
    if resolved.parent != temp_parent or not resolved.name.startswith('glw-audit-native-'):
        raise RuntimeError('Refusing cleanup outside this run directory')
    for attempt in range(4):
        try:
            shutil.rmtree(resolved)
            summary['isolatedProfileCleanup'] = 'complete'
            break
        except OSError as error:
            summary['isolatedProfileCleanup'] = f'preserved after cleanup failure: {error}'
            time.sleep(2)
    write_json(EVIDENCE / 'summary.json', summary)
    return 0 if all(row['completed'] and not row['timedOut'] for row in summary['rounds']) else 1

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--rounds', type=int, default=10)
    parser.add_argument('--long', action='store_true')
    parser.add_argument('--smoke', action='store_true', help='Use a separate evidence directory for a one-round diagnostic.')
    parser.add_argument('--artifact', type=Path, help='Use an explicit VSIX preserved under the workspace root.')
    arguments = parser.parse_args()
    if arguments.smoke:
        EVIDENCE = HERE / 'evidence' / ('performance-native-smoke-' + dt.datetime.now().strftime('%Y%m%d-%H%M%S'))
    try:
        sys.exit(run(arguments))
    except Exception as error:
        EVIDENCE.mkdir(parents=True, exist_ok=True)
        write_json(EVIDENCE / 'probe-error.json', {'error': str(error), 'type': type(error).__name__})
        raise
