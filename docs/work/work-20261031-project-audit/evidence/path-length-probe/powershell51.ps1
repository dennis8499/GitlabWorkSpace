[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$auditProbeRoot = [IO.Path]::GetFullPath('docs/work/work-20261031-project-audit/evidence/path-length-probe/ps51')
[IO.Directory]::CreateDirectory($auditProbeRoot) | Out-Null
$probeResults = foreach ($probeLength in @(227, 259, 260, 268, 280)) {
    $probeLeaf = 'x' * ($probeLength - $auditProbeRoot.Length - 1)
    $probeTarget = Join-Path $auditProbeRoot $probeLeaf
    try {
        [IO.File]::WriteAllText($probeTarget, 'probe')
        [pscustomobject]@{ requestedLength=$probeLength; actualLength=$probeTarget.Length; success=$true; exception=$null }
    } catch {
        $probeError = $_.Exception
        while ($probeError.InnerException) { $probeError = $probeError.InnerException }
        [pscustomobject]@{ requestedLength=$probeLength; actualLength=$probeTarget.Length; success=$false; exception=$probeError.GetType().FullName; message=$probeError.Message }
    }
}
$probeLongPaths = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -ErrorAction SilentlyContinue).LongPathsEnabled
$probeReport = [pscustomobject]@{ powershell=$PSVersionTable.PSVersion.ToString(); dotnet=[Environment]::Version.ToString(); longPathsEnabled=$probeLongPaths; records=$probeResults }
$probeReport | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $auditProbeRoot 'results.json') -Encoding UTF8
$probeReport | ConvertTo-Json -Depth 5
