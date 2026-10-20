# Own a Git process tree without a service, a Python runtime, or shell evaluation
# of command arguments. The parent validates receiptPath against its held lease.
# stdin: GitLabWorkspaceWindowsGit/v1 JSON; stdout/stderr: unmodified Git bytes.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($request.schema -ne 'GitLabWorkspaceWindowsGit/v1' -or
        $request.executable -isnot [string] -or [string]::IsNullOrWhiteSpace($request.executable) -or
        $request.executable.Contains([char]0) -or $request.args -isnot [Array] -or
        $request.nonce -isnot [string] -or $request.nonce -notmatch '^[A-Za-z0-9_-]{16,128}$' -or
        $request.receiptPath -isnot [string] -or -not [IO.Path]::IsPathRooted($request.receiptPath) -or
        [IO.File]::Exists($request.receiptPath) -or
        [double]$request.timeoutMs -lt 1 -or [double]$request.timeoutMs -gt [int]::MaxValue) {
        throw 'Invalid supervisor request.'
    }
    foreach ($argument in $request.args) {
        if ($argument -isnot [string] -or $argument.Contains([char]0)) { throw 'Invalid supervisor argument.' }
    }
    $workingDirectory = ''
    if ($request.PSObject.Properties['cwd'] -and $null -ne $request.cwd) {
        if ($request.cwd -isnot [string] -or -not [IO.Path]::IsPathRooted($request.cwd)) { throw 'Invalid working directory.' }
        $workingDirectory = $request.cwd
    }
    [byte[]]$inputBytes = @()
    if ($request.PSObject.Properties['inputBase64'] -and $null -ne $request.inputBase64) {
        $inputBytes = [Convert]::FromBase64String($request.inputBase64)
    }
    if (-not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($request.receiptPath))) { throw 'Missing lease directory.' }

    $supervisorSource = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public static class GitLabWorkspaceWindowsGitSupervisor {
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref ExtendedLimits information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int informationClass, out Accounting information, uint length, IntPtr returnedLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    // Windows CRT quoting; user text is never evaluated by PowerShell or cmd.exe.
    private static string Quote(string argument) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char value in argument) {
            if (value == '\\') { slashes++; continue; }
            if (value == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); }
            else { result.Append('\\', slashes); result.Append(value); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"');
        return result.ToString();
    }
    private static uint Active(IntPtr job) {
        Accounting accounting;
        if (!QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) {
            throw new IOException("Cannot confirm the Git process tree.");
        }
        return accounting.ActiveProcesses;
    }
    private static void Receipt(string path, string nonce, int exitCode) {
        // The nonce alphabet is validated before interpolation; no arguments,
        // environments, credentials, or Git output are persisted here.
        string payload = "{\"schema\":\"GitLabWorkspaceGitExecution/v1\",\"nonce\":\"" + nonce +
            "\",\"exitCode\":" + exitCode.ToString(System.Globalization.CultureInfo.InvariantCulture) + ",\"processTreeConfirmed\":true}";
        string temporary = path + ".tmp-" + nonce;
        byte[] bytes = new UTF8Encoding(false).GetBytes(payload);
        using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
            file.Write(bytes, 0, bytes.Length); file.Flush(true);
        }
        File.Move(temporary, path);
    }
    private static void Stop(IntPtr job) {
        // Includes this supervisor. There is deliberately no success receipt.
        TerminateJobObject(job, 125);
        CloseHandle(job);
        Environment.Exit(125);
    }
    public static int Run(string executable, string[] args, string cwd, int timeoutMs, byte[] input, string receiptPath, string nonce) {
        IntPtr job = IntPtr.Zero;
        bool started = false, assigned = false;
        try {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new IOException("Cannot create Git process supervision.");
            var limits = new ExtendedLimits();
            limits.BasicLimitInformation.LimitFlags = 0x00002000; // KILL_ON_JOB_CLOSE; no breakaways.
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))) ||
                !AssignProcessToJobObject(job, GetCurrentProcess())) throw new IOException("Cannot supervise Git on this host.");
            assigned = true;

            var arguments = new StringBuilder();
            foreach (string argument in args) { if (arguments.Length != 0) arguments.Append(' '); arguments.Append(Quote(argument)); }
            var start = new ProcessStartInfo(executable, arguments.ToString());
            start.UseShellExecute = false; start.CreateNoWindow = true; start.WindowStyle = ProcessWindowStyle.Hidden;
            start.RedirectStandardInput = true; start.RedirectStandardOutput = true; start.RedirectStandardError = true;
            if (!String.IsNullOrEmpty(cwd)) start.WorkingDirectory = cwd;
            using (var process = new Process()) {
                process.StartInfo = start;
                var elapsed = Stopwatch.StartNew();
                if (!process.Start()) throw new IOException("Cannot start Git.");
                started = true;
                Stream output = Console.OpenStandardOutput(), error = Console.OpenStandardError();
                Task stdout = process.StandardOutput.BaseStream.CopyToAsync(output);
                Task stderr = process.StandardError.BaseStream.CopyToAsync(error);
                Task stdin = Task.Run(async delegate {
                    try { if (input.Length != 0) await process.StandardInput.BaseStream.WriteAsync(input, 0, input.Length); }
                    catch (IOException) { /* Git may exit without reading its entire stdin. */ }
                    finally { try { process.StandardInput.Close(); } catch (IOException) {} }
                });
                if (!process.WaitForExit(timeoutMs)) { Stop(job); return 125; }
                // Allow short transport shutdown, but never confirm a surviving
                // ssh/index-pack/hook helper merely because the root Git exited.
                long grace = Math.Min(timeoutMs, elapsed.ElapsedMilliseconds + 250);
                while (Active(job) != 1 && elapsed.ElapsedMilliseconds < grace) Thread.Sleep(10);
                if (Active(job) != 1) { Stop(job); return 125; }
                int remaining = Math.Max(1, timeoutMs - (int)Math.Min(elapsed.ElapsedMilliseconds, timeoutMs));
                if (!Task.WaitAll(new Task[] { stdout, stderr, stdin }, remaining)) { Stop(job); return 125; }
                output.Flush(); error.Flush();
                int exitCode = process.ExitCode;
                if (Active(job) != 1) { Stop(job); return 125; }
                Receipt(receiptPath, nonce, exitCode);
                CloseHandle(job); // Kills this final member only, after flushing the receipt.
                return exitCode;
            }
        } catch {
            if (!started) {
                try { Receipt(receiptPath, nonce, 127); } catch { /* No receipt means fail closed. */ }
                try { Console.Error.WriteLine("Git supervision could not start the command."); } catch {}
                if (assigned) Stop(job);
                if (job != IntPtr.Zero) CloseHandle(job);
                return 127;
            }
            // An I/O, identity, or accounting failure cannot establish completion.
            Stop(job); return 125;
        }
    }
}
'@
    # This is a per-user, source-addressed compiler cache. The Git lease already
    # serializes production writers; stage a complete pair before publishing.
    # Only verified bytes are loaded, avoiding a hash-then-load-path race.
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    function Assert-OwnedLocalPath([string]$target, [bool]$directory) {
        $attributes = [IO.File]::GetAttributes($target)
        $isDirectory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $isDirectory -ne $directory) { throw 'Unsafe compiler cache path.' }
        $sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
        $acl = if ($directory) { [IO.Directory]::GetAccessControl($target, $sections) } else { [IO.File]::GetAccessControl($target, $sections) }
        if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $currentSid.Value) { throw 'Unexpected compiler cache owner.' }
        $writeRights = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
        foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                $rule.IdentityReference.Value -notin @($currentSid.Value, 'S-1-5-18', 'S-1-5-32-544') -and
                ($rule.FileSystemRights -band $writeRights) -ne 0) { throw 'Compiler cache is writable by another identity.' }
        }
    }
    function Bytes-Sha256([byte[]]$bytes) {
        $hash = [Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
        finally { $hash.Dispose() }
    }
    $runtimeRoot = [IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($request.receiptPath)))
    $cacheSafe = $true
    try { Assert-OwnedLocalPath $runtimeRoot $true } catch { $cacheSafe = $false }
    if (-not $cacheSafe) {
        # A custom runtime can inherit broad temporary-directory permissions.
        # Compile the shipped source in memory; never load a DLL from it.
        Add-Type -TypeDefinition $supervisorSource | Out-Null
    } else {
    $cacheRoot = Join-Path $runtimeRoot 'windows-git-supervisor-cache-v1'
    [IO.Directory]::CreateDirectory($cacheRoot) | Out-Null
    Assert-OwnedLocalPath $cacheRoot $true
    $sourceSha = Bytes-Sha256 ([Text.Encoding]::UTF8.GetBytes($supervisorSource))
    $cacheEntry = Join-Path $cacheRoot $sourceSha
    if (-not [IO.Directory]::Exists($cacheEntry)) {
        if ([IO.File]::Exists($cacheEntry)) { throw 'Unsafe compiler cache entry.' }
        $staging = Join-Path $cacheRoot ('.build-' + [Guid]::NewGuid().ToString('N'))
        [IO.Directory]::CreateDirectory($staging) | Out-Null
        try {
            Assert-OwnedLocalPath $staging $true
            $builtAssembly = Join-Path $staging 'supervisor.dll'
            Add-Type -TypeDefinition $supervisorSource -OutputAssembly $builtAssembly | Out-Null
            [byte[]]$builtBytes = [IO.File]::ReadAllBytes($builtAssembly)
            $manifest = @{ schema = 'GitLabWorkspaceWindowsGitCache/v1'; sourceSha256 = $sourceSha; binarySha256 = (Bytes-Sha256 $builtBytes) } | ConvertTo-Json -Compress
            [IO.File]::WriteAllText((Join-Path $staging 'manifest.json'), $manifest, (New-Object Text.UTF8Encoding($false)))
            [IO.Directory]::Move($staging, $cacheEntry)
        } finally {
            # An interrupted staging directory contains no published executable.
            # Leave it for explicit inspection rather than recursively deleting.
        }
    }
    Assert-OwnedLocalPath $cacheEntry $true
    $assemblyPath = Join-Path $cacheEntry 'supervisor.dll'
    $manifestPath = Join-Path $cacheEntry 'manifest.json'
    Assert-OwnedLocalPath $assemblyPath $false
    Assert-OwnedLocalPath $manifestPath $false
    if (([IO.FileInfo]::new($assemblyPath)).Length -gt 2097152 -or ([IO.FileInfo]::new($manifestPath)).Length -gt 4096) { throw 'Invalid compiler cache size.' }
    $record = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
    [byte[]]$assemblyBytes = [IO.File]::ReadAllBytes($assemblyPath)
    if ($record.schema -ne 'GitLabWorkspaceWindowsGitCache/v1' -or $record.sourceSha256 -ne $sourceSha -or
        $record.binarySha256 -notmatch '^[0-9a-f]{64}$' -or (Bytes-Sha256 $assemblyBytes) -ne $record.binarySha256) { throw 'Compiler cache verification failed.' }
    [Reflection.Assembly]::Load($assemblyBytes) | Out-Null
    }
    $code = [GitLabWorkspaceWindowsGitSupervisor]::Run(
        [string]$request.executable, [string[]]$request.args, $workingDirectory,
        [int]$request.timeoutMs, $inputBytes, [string]$request.receiptPath, [string]$request.nonce)
    exit $code
} catch {
    [Console]::Error.WriteLine('Git supervisor request could not be processed.')
    exit 125
}
