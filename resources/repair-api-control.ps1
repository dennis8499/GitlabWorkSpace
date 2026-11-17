# Run offline as the OS user whose GitLab Workspace log reports the failure.
# Inspection is the default. This script never deletes files or recursively removes directories.
[CmdletBinding()]
param(
    [string]$RuntimeRoot = $(if ($env:GITLAB_WORKSPACE_RUNTIME_DIR) { $env:GITLAB_WORKSPACE_RUNTIME_DIR } else { Join-Path $env:LOCALAPPDATA 'GitLabWorkspace\runtime-v1' }),
    [string]$LeasePath,
    [switch]$Apply,
    [switch]$ClientsStopped,
    [switch]$Interactive
)

function Assert-RepairLocalDirectory {
    param([Parameter(Mandatory = $true)][string]$LiteralPath, [switch]$AllowMissing)
    $fullPath = [IO.Path]::GetFullPath($LiteralPath)
    if ($LiteralPath -notmatch '\A[A-Za-z]:[\\/]') { throw 'A fully qualified local directory is required.' }
    $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($fullPath))
    if ($drive.DriveType -eq [IO.DriveType]::Network) { throw 'Network drives are not supported.' }
    if ($AllowMissing -and -not (Test-Path -LiteralPath $fullPath -ErrorAction Stop)) {
        $ancestor = [IO.Path]::GetDirectoryName($fullPath)
        while ($ancestor -and -not (Test-Path -LiteralPath $ancestor -ErrorAction Stop)) { $ancestor = [IO.Path]::GetDirectoryName($ancestor) }
        if (-not $ancestor) { throw 'The local drive is unavailable.' }
        $null = Assert-RepairLocalDirectory $ancestor
        return $fullPath.TrimEnd([IO.Path]::DirectorySeparatorChar)
    }
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
    $rootPath = Assert-RepairLocalDirectory $RuntimeRoot -AllowMissing
    $fullPath = [IO.Path]::GetFullPath($LeasePath)
    $prefix = $rootPath + [IO.Path]::DirectorySeparatorChar
    if ($LeasePath -notmatch '\A[A-Za-z]:[\\/]' -or -not $fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'The lease must be a fully qualified path inside the specified runtime root.' }
    $relative = $fullPath.Substring($prefix.Length)
    if ($relative -notmatch '\Aapi\\[a-f0-9]{64}\\control\.lock\z') { throw 'Only api/<64-character host hash>/control.lock is supported.' }
    # Inspect existing ancestors even when the final lock no longer exists.
    $null = Assert-RepairLocalDirectory ([IO.Path]::GetDirectoryName($fullPath)) -AllowMissing
    if (-not (Test-Path -LiteralPath $fullPath -ErrorAction Stop)) { return [pscustomobject]@{ LeasePath = $fullPath; Status = 'Missing'; Entries = @() } }
    $checked = Assert-RepairLocalDirectory $fullPath
    try { $entries = @([IO.Directory]::EnumerateFileSystemEntries($checked) | ForEach-Object { [IO.Path]::GetFileName($_) }) }
    catch [IO.DirectoryNotFoundException] { return [pscustomobject]@{ LeasePath = $fullPath; Status = 'Missing'; Entries = @() } }
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
    $rootPath = Assert-RepairLocalDirectory $RuntimeRoot -AllowMissing
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
    try { [IO.Directory]::Delete($inspection.LeasePath, $false) }
    catch [IO.DirectoryNotFoundException] { return [pscustomobject]@{ LeasePath = $inspection.LeasePath; Status = 'Missing'; Entries = @() } }
    return [pscustomobject]@{ LeasePath = $inspection.LeasePath; Status = 'Removed'; Entries = @() }
}

function Invoke-InteractiveApiControlRepair {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$RuntimeRoot, [Parameter(Mandatory = $true)][string]$LeasePath)
    Write-Host 'GitLab Workspace - 本機連線復原'
    Write-Host '此工具只移除確認為空的 API 控制鎖，不會送出 GitLab 請求。'
    while ($true) {
        $inspection = Invoke-ApiControlRepair -RuntimeRoot $RuntimeRoot -LeasePath $LeasePath
        Write-Host ('鎖路徑：' + $inspection.LeasePath)
        if ($inspection.Status -eq 'Missing') {
            Write-Host '鎖已不存在（Missing），可重新開啟 VS Code 登入。完成後可關閉此視窗。'
            return $inspection
        }
        if ($inspection.Status -ne 'Empty') {
            Write-Host ('目錄不是空的（NotEmpty），全部檔案已保留：' + ($inspection.Entries -join '、'))
            Write-Host '請保留此輸出與 Log 供後續檢查。可關閉此視窗。'
            return $inspection
        }
        Write-Host '請先保存工作、停止相關任務，完全關閉所有使用此 runtime 的 VS Code、Extension Host、其他編輯器與 CLI 客戶端。'
        Write-Host '修復期間不要重新啟動客戶端；本視窗會繼續執行，不會自動關閉編輯器或終止任務。'
        $choice = Read-Host '已確認所有相關客戶端停止後輸入 Y 開始復原；輸入 Q 取消'
        if ($choice -ieq 'Q') { Write-Host '已取消，未進行修復。可關閉此視窗。'; return [pscustomobject]@{ LeasePath = $inspection.LeasePath; Status = 'Cancelled'; Entries = @() } }
        if ($choice -ine 'Y') { continue }
        $hosts = @(Get-RunningApiHosts)
        if ($hosts.Count -gt 0) {
            foreach ($hostProcess in $hosts) { Write-Host ('仍在執行：' + $hostProcess.Name + ' (PID ' + $hostProcess.ProcessId + ')') }
            Write-Host '尚未修復；請關閉相關程序後再確認，或輸入 Q 取消。'
            continue
        }
        # The user's explicit confirmation covers clients that cannot be inferred
        # from process names. Apply repeats process, path and contents checks.
        $result = Invoke-ApiControlRepair -RuntimeRoot $RuntimeRoot -LeasePath $LeasePath -Apply -ClientsStopped
        Write-Host ('復原結果：' + $result.Status + '。請重新開啟 VS Code 登入 GitLab。完成後可關閉此視窗。')
        return $result
    }
}

# Dot-sourcing exposes the same checks for isolated tests without running a repair.
if ($MyInvocation.InvocationName -ne '.') {
    if ($Interactive) {
        try {
            if (-not $LeasePath -or $Apply -or $ClientsStopped) { throw 'Interactive requires one explicit LeasePath and cannot be combined with Apply or ClientsStopped.' }
            Invoke-InteractiveApiControlRepair -RuntimeRoot $RuntimeRoot -LeasePath $LeasePath | Format-List
        }
        catch { Write-Host ('復原未完成，全部未確認資料均已保留：' + $_.Exception.Message) -ForegroundColor Red; Write-Host '請保留輸出與 Log。可關閉此視窗。' }
    } else {
        try { Invoke-ApiControlRepair -RuntimeRoot $RuntimeRoot -LeasePath $LeasePath -Apply:$Apply -ClientsStopped:$ClientsStopped | ConvertTo-Json -Depth 4 }
        catch { Write-Error $_; exit 1 }
    }
}
