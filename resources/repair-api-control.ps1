# Run offline as the OS user whose GitLab Workspace log reports the failure.
# Inspection is the default. This script never deletes files or recursively removes directories.
[CmdletBinding()]
param(
    [string]$RuntimeRoot = $(if ($env:GITLAB_WORKSPACE_RUNTIME_DIR) { $env:GITLAB_WORKSPACE_RUNTIME_DIR } else { Join-Path $env:LOCALAPPDATA 'GitLabWorkspace\runtime-v1' }),
    [string]$LeasePath,
    [switch]$Apply,
    [switch]$ClientsStopped
)

function Assert-RepairLocalDirectory {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    $fullPath = [IO.Path]::GetFullPath($LiteralPath)
    if ($LiteralPath -notmatch '\A[A-Za-z]:[\\/]') { throw 'A fully qualified local directory is required.' }
    $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($fullPath))
    if ($drive.DriveType -eq [IO.DriveType]::Network) { throw 'Network drives are not supported.' }
    $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) { throw 'The repair path must be a directory.' }
    $current = $item
    while ($null -ne $current) {
        if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points and redirected directories are not supported.' }
        $current = $current.Parent
    }
    return $item.FullName.TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Get-ApiControlInspection {
    param([Parameter(Mandatory = $true)][string]$RuntimeRoot, [Parameter(Mandatory = $true)][string]$LeasePath)
    $rootPath = Assert-RepairLocalDirectory $RuntimeRoot
    $fullPath = [IO.Path]::GetFullPath($LeasePath)
    $prefix = $rootPath + [IO.Path]::DirectorySeparatorChar
    if ($LeasePath -notmatch '\A[A-Za-z]:[\\/]' -or -not $fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'The lease must be a fully qualified path inside the specified runtime root.' }
    $relative = $fullPath.Substring($prefix.Length)
    if ($relative -notmatch '\Aapi\\[a-f0-9]{64}\\control\.lock\z') { throw 'Only api/<64-character host hash>/control.lock is supported.' }
    # Inspect existing ancestors even when the final lock no longer exists.
    $null = Assert-RepairLocalDirectory ([IO.Path]::GetDirectoryName($fullPath))
    if (-not (Test-Path -LiteralPath $fullPath -ErrorAction Stop)) { return [pscustomobject]@{ LeasePath = $fullPath; Status = 'Missing'; Entries = @() } }
    $checked = Assert-RepairLocalDirectory $fullPath
    $entries = @([IO.Directory]::EnumerateFileSystemEntries($checked) | ForEach-Object { [IO.Path]::GetFileName($_) })
    return [pscustomobject]@{ LeasePath = $checked; Status = $(if ($entries.Count -eq 0) { 'Empty' } else { 'NotEmpty' }); Entries = $entries }
}

function Get-RunningApiHosts {
    # Enumeration failure must fail closed. The explicit ClientsStopped assertion
    # also covers CLI clients and renamed/custom hosts that cannot be inferred here.
    return @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object {
        $_.Name -match '\A(Code(?: - Insiders| - OSS)?|VSCodium|codium|Cursor|Windsurf)\.exe\z' -or
        $_.CommandLine -match '(?:--type[= ]extensionHost|bootstrap-fork.+extensionHost)'
    } | Select-Object ProcessId, Name)
}

function Invoke-ApiControlRepair {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$RuntimeRoot, [string]$LeasePath, [switch]$Apply, [switch]$ClientsStopped)
    $rootPath = Assert-RepairLocalDirectory $RuntimeRoot
    if (-not $LeasePath) {
        if ($Apply) { throw 'Apply requires one explicit LeasePath; bulk repair is not supported.' }
        $apiPath = Join-Path $rootPath 'api'
        if (-not (Test-Path -LiteralPath $apiPath -ErrorAction Stop)) { return }
        $apiPath = Assert-RepairLocalDirectory $apiPath
        foreach ($hostPath in [IO.Directory]::EnumerateDirectories($apiPath)) {
            if ([IO.Path]::GetFileName($hostPath) -match '\A[a-f0-9]{64}\z') {
                Get-ApiControlInspection -RuntimeRoot $rootPath -LeasePath (Join-Path $hostPath 'control.lock')
            }
        }
        return
    }
    if ($Apply) {
        if (-not $ClientsStopped) { throw 'Apply requires ClientsStopped after closing every related client. Do not restart them during repair.' }
        if (@(Get-RunningApiHosts).Count -gt 0) { throw 'A related host is still running. Close all related clients before repair.' }
    }
    $inspection = Get-ApiControlInspection -RuntimeRoot $rootPath -LeasePath $LeasePath
    if (-not $Apply -or $inspection.Status -eq 'Missing') { return $inspection }
    if ($inspection.Status -ne 'Empty') { throw 'The lock is not empty. All contents were preserved; inspect the reported entries manually.' }
    # Recheck after inspection; non-recursive Delete also rejects any new contents.
    if (@(Get-RunningApiHosts).Count -gt 0) { throw 'A related host started during inspection. Repair stopped.' }
    $inspection = Get-ApiControlInspection -RuntimeRoot $rootPath -LeasePath $LeasePath
    if ($inspection.Status -eq 'Missing') { return $inspection }
    if ($inspection.Status -ne 'Empty') { throw 'The lock changed during inspection. Repair stopped.' }
    [IO.Directory]::Delete($inspection.LeasePath, $false)
    return [pscustomobject]@{ LeasePath = $inspection.LeasePath; Status = 'Removed'; Entries = @() }
}

# Dot-sourcing exposes the same checks for isolated tests without running a repair.
if ($MyInvocation.InvocationName -ne '.') {
    try { Invoke-ApiControlRepair -RuntimeRoot $RuntimeRoot -LeasePath $LeasePath -Apply:$Apply -ClientsStopped:$ClientsStopped | ConvertTo-Json -Depth 4 }
    catch { Write-Error $_; exit 1 }
}
