# Loaded only in the dedicated terminal. The host supplies the launch after Enter.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$pipeName = $env:GITLAB_WORKSPACE_CODEX_PIPE
$nonce = $env:GITLAB_WORKSPACE_CODEX_NONCE
if ($pipeName -notmatch '^glw-codex-[0-9a-f-]{36}$' -or $nonce -notmatch '^[0-9a-f]{48}$') {
    throw 'Invalid GitLab Workspace Codex terminal.'
}
Remove-Item Env:\GITLAB_WORKSPACE_CODEX_SCRIPT, Env:\GITLAB_WORKSPACE_CODEX_PIPE, Env:\GITLAB_WORKSPACE_CODEX_NONCE
$encoding = [Text.UTF8Encoding]::new($false)

$invokeCodex = {
    if ($args.Count -ne 0) { throw '請保留預填的 codex 指令。' }
    $client = [IO.Pipes.NamedPipeClientStream]::new('.', $pipeName, [IO.Pipes.PipeDirection]::InOut)
    $child = $null
    try {
        $client.Connect(5000)
        $reader = [IO.StreamReader]::new($client, $encoding)
        $writer = [IO.StreamWriter]::new($client, $encoding)
        $writer.AutoFlush = $true
        $writer.WriteLine('start ' + $nonce)
        Write-Host 'GitLab Workspace 正在準備 Codex 工作…'
        $response = $reader.ReadLineAsync()
        while (-not $response.IsCompleted) { Start-Sleep -Milliseconds 100 }
        $line = $response.GetAwaiter().GetResult()
        if ($null -eq $line) { throw 'GitLab Workspace 已停止本次啟動。請查看工作台的作業訊息。' }

        try {
            $launch = ConvertFrom-Json -InputObject $line -ErrorAction Stop
            $start = [Diagnostics.ProcessStartInfo]::new($launch.file)
            $start.UseShellExecute = $false
            $start.WorkingDirectory = $launch.cwd
            foreach ($argument in $launch.args) { $start.ArgumentList.Add($argument) }
            # Inherit the PowerShell terminal's console for the interactive CLI.
            $child = [Diagnostics.Process]::Start($start)
            if ($null -eq $child) { throw 'Codex CLI 程序未啟動。' }
        } catch {
            $writer.WriteLine('not-started')
            throw
        }
        $child.WaitForExit()
        $global:LASTEXITCODE = $child.ExitCode
        $writer.WriteLine('exit ' + $child.ExitCode.ToString([Globalization.CultureInfo]::InvariantCulture))
    } finally {
        if ($null -ne $child) { $child.Dispose() }
        $client.Dispose()
    }
}.GetNewClosure()

if (Test-Path -LiteralPath 'Alias:codex') { Remove-Item -LiteralPath 'Alias:codex' -Force }
Set-Item -LiteralPath 'Function:global:codex' -Value $invokeCodex

# Acknowledge the completed setup before the host inserts text on the prompt.
$ready = [IO.Pipes.NamedPipeClientStream]::new('.', $pipeName, [IO.Pipes.PipeDirection]::Out)
try {
    $ready.Connect(5000)
    $writer = [IO.StreamWriter]::new($ready, $encoding)
    $writer.WriteLine('ready ' + $nonce)
    $writer.Flush()
} finally {
    $ready.Dispose()
}
