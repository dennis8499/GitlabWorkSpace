# Run as the Windows user whose GitLab Workspace log identifies the lock.
[CmdletBinding()]
param(
    [string]$StorageRoot,
    [string]$RuntimeRoot,
    [string]$LeasePath,
    [string]$SnapshotPath,
    [switch]$Apply,
    [switch]$ClientsStopped
)

$workflowLeaseNativeSource = Join-Path $PSScriptRoot 'repair-workflow-lease-native.cs'

function Resolve-WorkflowLeaseLocalPath {
    param([string]$Path)
    if ($Path -notmatch '\A[A-Za-z]:[\\/]' -or $Path.Substring(2).Contains(':') -or
        $Path -match '(?:[\\/])[^\\/]*[. ](?:[\\/]|\z)') {
        throw 'A fully qualified, unambiguous local path is required.'
    }
    $full = [IO.Path]::GetFullPath($Path)
    $driveRoot = [IO.Path]::GetPathRoot($full)
    if ([IO.DriveInfo]::new($driveRoot).DriveType -ne [IO.DriveType]::Fixed) {
        throw 'The path must be on a local fixed drive.'
    }
    if ($full.Length -eq $driveRoot.Length) { return $full }
    return $full.TrimEnd('\')
}

function Get-WorkflowLeaseBootObservation {
    $boot = (Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime
    if ($boot -isnot [DateTime]) { throw 'Windows boot time could not be verified.' }
    $boot = $boot.ToUniversalTime()
    $now = [DateTime]::UtcNow
    if ($boot -eq [DateTime]::MinValue -or $boot -gt $now) { throw 'Windows boot time could not be verified.' }
    return @{ BootUtc = $boot; ObservedUtc = $now }
}

function Assert-WorkflowLeaseClientsStopped {
    # The explicit confirmation also covers renamed editors, CLI clients and helpers.
    $editors = @('Code', 'Code - Insiders', 'Code - OSS', 'VSCodium', 'codium', 'Cursor', 'Windsurf')
    $running = @(Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -in $editors })
    if ($running.Count -gt 0) {
        throw ('Close all related clients and keep them closed during repair. Found: ' + ($running.ProcessName -join ', '))
    }
}

function Assert-WorkflowLeaseProcessStopped {
    param([int]$OwnerProcessId)
    try { $process = [Diagnostics.Process]::GetProcessById($OwnerProcessId) }
    catch [ArgumentException] { return }
    try {
        if (-not $process.HasExited) { throw 'A recorded lease process is still running. The lock was preserved.' }
    }
    finally { $process.Dispose() }
}

function Read-WorkflowLeaseJson {
    param([string]$Path, [int]$Limit)
    $bytes = [WorkflowLeaseDirectory]::ReadDocument($Path, $Limit)
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
    try { $data = ConvertFrom-Json -InputObject $text -ErrorAction Stop }
    catch { throw 'The lock or snapshot metadata is invalid.' }
    if ($data -isnot [pscustomobject]) { throw 'The lock or snapshot metadata is invalid.' }
    return @{ Data = $data; Bytes = $bytes }
}

function Get-WorkflowLeaseContents {
    param([WorkflowLeaseDirectory]$Directory, [string]$Kind)
    $entries = @([IO.Directory]::GetFileSystemEntries($Directory.PathName) | Sort-Object)
    if ($entries.Count -eq 0) { return @{ Content = 'Empty'; Digest = '' } }
    $ownerPath = [IO.Path]::Combine($Directory.PathName, 'owner.json')
    if ($ownerPath -cnotin $entries -or $entries.Count -gt 18) {
        throw 'The lock contains unexpected entries. The lock was preserved.'
    }
    $metadata = Read-WorkflowLeaseJson $ownerPath 4096
    $owner = $metadata.Data
    $nonce = [Guid]::Empty
    if ($owner.schema -cne 'GitLabWorkspaceLease/v1' -or $owner.kind -cne $Kind -or
        (-not [Guid]::TryParseExact([string]$owner.nonce, 'D', [ref]$nonce) -and
         -not [Guid]::TryParseExact([string]$owner.nonce, 'N', [ref]$nonce)) -or $nonce -eq [Guid]::Empty -or
        $owner.pid -isnot [int] -or $owner.pid -lt 1 -or
        $owner.state -cnotin @('reserved', 'starting', 'running', 'quarantined') -or
        ($null -ne $owner.childPid -and ($owner.childPid -isnot [int] -or $owner.childPid -lt 1))) {
        throw 'The lease owner metadata could not be verified. The lock was preserved.'
    }
    Assert-WorkflowLeaseProcessStopped $owner.pid
    if ($null -ne $owner.childPid) { Assert-WorkflowLeaseProcessStopped $owner.childPid }
    $versioned = $null -ne $owner.PSObject.Properties['lifecycle']
    if ($versioned) {
        if ($owner.lifecycle.version -ne 2 -or $owner.lifecycle.directoryId -cne $Directory.Identity -or
            $owner.lifecycle.jobs -isnot [array]) {
            throw 'The lease lifecycle metadata could not be verified. The lock was preserved.'
        }
        foreach ($job in $owner.lifecycle.jobs) {
            if ($job.pid -isnot [int] -or $job.pid -lt 1) { throw 'Invalid supervisor PID. The lock was preserved.' }
            Assert-WorkflowLeaseProcessStopped $job.pid
        }
    }
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
        $parts = @([BitConverter]::ToString($hash.ComputeHash($metadata.Bytes)).Replace('-', ''))
        foreach ($entry in $entries) {
            if ($entry -ceq $ownerPath) { continue }
            $name = [IO.Path]::GetFileName($entry)
            if ($Kind -ceq 'git' -and $name -cmatch '\Aexecution-([a-f0-9-]{36})\.json\z') {
                $receipt = (Read-WorkflowLeaseJson $entry 4096).Data
                if ($receipt.schema -cne 'GitLabWorkspaceGitExecution/v1' -or $receipt.nonce -cne $Matches[1]) {
                    throw 'The Git receipt could not be verified. The lock was preserved.'
                }
            } elseif (-not ($versioned -and $name -cmatch '\A\.owner-[a-f0-9]{32}\.tmp\z')) {
                throw 'The lock contains unexpected entries. The lock was preserved.'
            }
            $bytes = [WorkflowLeaseDirectory]::ReadDocument($entry, 4096, $true)
            $parts += $name + '=' + [BitConverter]::ToString($hash.ComputeHash($bytes)).Replace('-', '')
        }
        $digest = $parts -join '|'
    }
    finally { $hash.Dispose() }
    return @{ Content = 'Owner'; Digest = $digest }
}

function Invoke-WorkflowLeaseRepair {
    [CmdletBinding()]
    param([string]$StorageRoot, [string]$RuntimeRoot, [string]$LeasePath, [string]$SnapshotPath,
        [switch]$Apply, [switch]$ClientsStopped)
    if ([bool]$StorageRoot -eq [bool]$RuntimeRoot) { throw 'Specify exactly one StorageRoot or RuntimeRoot.' }
    if (-not $LeasePath -or -not $SnapshotPath) { throw 'An explicit LeasePath and SnapshotPath are required.' }
    if ($Apply -ne $ClientsStopped) { throw 'Apply requires ClientsStopped after closing all related clients.' }

    $root = Resolve-WorkflowLeaseLocalPath $(if ($StorageRoot) { $StorageRoot } else { $RuntimeRoot })
    $lease = Resolve-WorkflowLeaseLocalPath $LeasePath
    $snapshotFile = Resolve-WorkflowLeaseLocalPath $SnapshotPath
    $prefix = $root.TrimEnd('\') + '\'
    if (-not $lease.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The lock path must be inside the specified root.'
    }
    $relative = $lease.Substring($prefix.Length)
    $kind = switch -Regex -CaseSensitive ($relative) {
        '\Aworkflow-kit-asset-locks\\[a-f0-9]{64}\.lock\z' { if ($StorageRoot) { 'workflow-kit-asset' } }
        '\Aworkflow-kit-cache\.control\z' { if ($StorageRoot) { 'workflow-kit-cache-control' } }
        '\Acodex-workspaces\\[a-f0-9]{64}\.lock\z' { if ($RuntimeRoot) { 'codex' } }
        '\Agit-network\.lock\z' { if ($RuntimeRoot) { 'git' } }
        '\Aapi\\[a-f0-9]{64}\\control\.lock\z' { if ($RuntimeRoot) { 'api-control' } }
        '\Acodex-repositories\\[a-f0-9]{64}\.control\z' { if ($StorageRoot) { 'codex-repository-cache' } }
        '\Abmad-artifacts\\[a-f0-9]{64}\\[a-f0-9-]{36}\.control\z' { if ($StorageRoot) { 'bmad-artifacts' } }
        '\Abmad-artifacts\\[a-f0-9]{64}\\project-apply\.control\z' { if ($StorageRoot) { 'bmad-project-apply' } }
        '\Acodex-bmad-artifacts\\[a-f0-9-]{36}\.continuation\.control\z' { if ($StorageRoot) { 'bmad-continuation' } }
    }
    if (-not $kind) { throw 'The path is not a supported local lease.' }
    if ($snapshotFile -ieq $root -or $snapshotFile.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The snapshot must be outside the specified storage or runtime root.'
    }

    if (-not ('WorkflowLeaseDirectory' -as [type])) { Add-Type -Path $workflowLeaseNativeSource -ErrorAction Stop }
    if ($Apply) { Assert-WorkflowLeaseClientsStopped }
    try { $directory = [WorkflowLeaseDirectory]::Open($lease, [bool]$Apply) }
    catch [IO.FileNotFoundException] { return [pscustomobject]@{ Status = 'Missing'; LeasePath = $lease; Kind = $kind } }

    try {
        $content = Get-WorkflowLeaseContents $directory $kind
        $boot = Get-WorkflowLeaseBootObservation
        $user = [Security.Principal.WindowsIdentity]::GetCurrent()
        try { $userId = $user.User.Value }
        finally { $user.Dispose() }

        $snapshotParent = [WorkflowLeaseDirectory]::Open([IO.Path]::GetDirectoryName($snapshotFile), $false)
        try {
            if (-not $Apply) {
                $snapshot = [ordered]@{
                    Schema = 'GitLabWorkspaceWorkflowLeaseRepair/v1'; LeasePath = $lease; Kind = $kind
                    DirectoryIdentity = $directory.Identity; Content = $content.Content; Digest = $content.Digest
                    UserSid = $userId; BootUtc = $boot.BootUtc.ToString('o'); CapturedUtc = $boot.ObservedUtc.ToString('o')
                }
                $data = [Text.Encoding]::UTF8.GetBytes(($snapshot | ConvertTo-Json -Compress))
                $stream = [IO.File]::Open($snapshotFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                try { $stream.Write($data, 0, $data.Length); $stream.Flush($true) }
                finally { $stream.Dispose() }
                return [pscustomobject]@{ Status = 'Captured'; LeasePath = $lease; Kind = $kind; SnapshotPath = $snapshotFile }
            }

            $snapshot = (Read-WorkflowLeaseJson $snapshotFile 16384).Data
            if ($snapshot.Schema -cne 'GitLabWorkspaceWorkflowLeaseRepair/v1' -or $snapshot.LeasePath -ine $lease -or
                $snapshot.Kind -cne $kind -or $snapshot.DirectoryIdentity -cne $directory.Identity -or
                $snapshot.Content -cne $content.Content -or $snapshot.Digest -cne $content.Digest -or $snapshot.UserSid -cne $userId) {
                throw 'The lock or Windows user differs from the captured snapshot. The lock was preserved.'
            }
            $format = [Globalization.CultureInfo]::InvariantCulture
            $dateStyle = [Globalization.DateTimeStyles]::RoundtripKind
            $previousBoot = [DateTime]::ParseExact($snapshot.BootUtc, 'o', $format, $dateStyle)
            $capturedAt = [DateTime]::ParseExact($snapshot.CapturedUtc, 'o', $format, $dateStyle)
            if ($previousBoot -gt $capturedAt -or $boot.BootUtc -le $capturedAt) {
                throw 'Use Windows Restart after capture before applying the repair. The lock was preserved.'
            }

            Assert-WorkflowLeaseClientsStopped
            $current = Get-WorkflowLeaseContents $directory $kind
            if ($current.Content -cne $content.Content -or $current.Digest -cne $content.Digest) {
                throw 'The lock contents changed during verification. The lock was preserved.'
            }
            $sibling = [IO.Path]::GetFileName($lease) + '.retired-' + [Guid]::NewGuid().ToString('D')
            $retired = $directory.Retire($sibling)
            return [pscustomobject]@{ Status = 'Retired'; LeasePath = $lease; Kind = $kind; RetiredPath = $retired }
        }
        finally { $snapshotParent.Dispose() }
    }
    finally { $directory.Dispose() }
}

if ($MyInvocation.InvocationName -ne '.') {
    try { Invoke-WorkflowLeaseRepair @PSBoundParameters | ConvertTo-Json -Compress }
    catch { Write-Error $_; exit 1 }
}
