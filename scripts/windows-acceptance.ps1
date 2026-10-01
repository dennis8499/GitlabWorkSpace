[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repositoryPrefix = $repositoryRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$temporaryParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$temporaryRoot = [System.IO.Path]::GetFullPath((Join-Path $temporaryParent ('gitlab-workspace-windows-' + [Guid]::NewGuid().ToString('N'))))
$node = Get-Command node.exe -ErrorAction SilentlyContinue
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
$git = Get-Command git.exe -ErrorAction SilentlyContinue
$code = Get-Command code.cmd -ErrorAction SilentlyContinue

function Get-RepositoryRelativePath([string]$TargetPath) {
    $fullPath = [System.IO.Path]::GetFullPath($TargetPath)
    if (-not $fullPath.StartsWith($repositoryPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'The evidence path is outside the repository.'
    }
    return $fullPath.Substring($repositoryPrefix.Length)
}

if (-not $node -or -not $npm -or -not $git -or -not $code) {
    throw 'Install Node.js 24, Git, and VS Code; add node.exe, npm.cmd, git.exe, and code.cmd to PATH.'
}

if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [System.Runtime.InteropServices.Architecture]::X64) {
    throw 'This acceptance script targets x64 Windows.'
}

if (-not $temporaryRoot.StartsWith($temporaryParent, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The temporary directory is outside the system temporary directory.'
}

$originalLocation = Get-Location
$startedAt = [DateTimeOffset]::UtcNow
try {
    New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
    Set-Location -LiteralPath $repositoryRoot

    $versionProbe = Join-Path $temporaryRoot 'python-version.py'
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($versionProbe, "import sys`nprint(sys.version.split()[0])`n", $utf8)
    $pythonOutput = @(& $node.Source (Join-Path $repositoryRoot 'scripts/run-python.mjs') $versionProbe 2>&1)
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.11 or newer could not be started.' }
    $pythonVersion = ($pythonOutput -join "`n").Trim()

    $unicodeName = [string][char]0x4E2D + [string][char]0x6587
    $gitRepository = Join-Path $temporaryRoot ('Group ' + $unicodeName + ' with spaces')
    New-Item -ItemType Directory -Path $gitRepository -Force | Out-Null
    & $git.Source -C $gitRepository init --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Git could not initialize a repository in a Unicode path with spaces.' }
    $mixedNewlineFile = Join-Path $gitRepository ($unicodeName + '.txt')
    [System.IO.File]::WriteAllText($mixedNewlineFile, "first`r`nsecond`n", $utf8)
    $mixedNewlineText = [System.IO.File]::ReadAllText($mixedNewlineFile, $utf8)
    if ($mixedNewlineText -notmatch "first`r`nsecond`n") { throw 'The mixed CRLF/LF fixture did not round-trip.' }
    & $git.Source -C $gitRepository status --porcelain=v1 --untracked-files=all | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Git could not read the Unicode fixture path.' }

    $outsideDirectory = Join-Path $temporaryRoot 'outside'
    $groupDirectory = Join-Path $temporaryRoot 'junction-test'
    New-Item -ItemType Directory -Path $outsideDirectory, $groupDirectory -Force | Out-Null
    $junctionPath = Join-Path $groupDirectory 'workspace-link'
    New-Item -ItemType Junction -Path $junctionPath -Target $outsideDirectory | Out-Null
    if ((Get-Item -LiteralPath $junctionPath).LinkType -ne 'Junction') { throw 'Windows failed to create the junction fixture.' }
    $junctionProbe = Join-Path $temporaryRoot 'junction-probe.py'
    $junctionProbeSource = @'
import importlib.util
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("tool_installer", sys.argv[1])
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
try:
    installer.safe_group_path(Path(sys.argv[2]), "workspace-link/payload")
except ValueError:
    raise SystemExit(0)
raise SystemExit("junction path was accepted")
'@
    [System.IO.File]::WriteAllText($junctionProbe, $junctionProbeSource, $utf8)
    & $node.Source (Join-Path $repositoryRoot 'scripts/run-python.mjs') $junctionProbe (Join-Path $repositoryRoot 'resources/tool-installer.py') $groupDirectory
    if ($LASTEXITCODE -ne 0) { throw 'The installer accepted a junction inside a Group workspace path.' }

    & $npm.Source test
    if ($LASTEXITCODE -ne 0) { throw 'npm test failed.' }

    $manifest = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $repositoryRoot 'package.json') | ConvertFrom-Json
    $vsixPath = Join-Path $repositoryRoot ('dist/' + $manifest.name + '-' + $manifest.version + '.vsix')
    if (-not (Test-Path -LiteralPath $vsixPath -PathType Leaf)) { throw 'npm test did not produce the expected VSIX.' }

    $userDataDirectory = Join-Path $temporaryRoot 'vscode-user-data'
    $extensionsDirectory = Join-Path $temporaryRoot 'vscode-extensions'
    & $code.Source --user-data-dir $userDataDirectory --extensions-dir $extensionsDirectory --install-extension $vsixPath --force
    if ($LASTEXITCODE -ne 0) { throw 'VS Code could not install the VSIX into the isolated profile.' }
    $installedExtensions = @(& $code.Source --user-data-dir $userDataDirectory --extensions-dir $extensionsDirectory --list-extensions --show-versions)
    if ($LASTEXITCODE -ne 0 -or $installedExtensions -notcontains ($manifest.publisher + '.' + $manifest.name + '@' + $manifest.version)) {
        throw 'The expected extension version is missing from the isolated VS Code profile.'
    }

    $windows = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    $windowsProductName = if ([int]$windows.CurrentBuildNumber -ge 22000) { 'Windows 11' } else { 'Windows 10' }
    $gitCommit = (& $git.Source -C $repositoryRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Git could not identify the source commit.' }
    $gitStatus = @(& $git.Source -C $repositoryRoot status --porcelain)
    if ($LASTEXITCODE -ne 0) { throw 'Git could not inspect the source working tree.' }
    $npmVersion = (& $npm.Source --version | Select-Object -First 1).Trim()
    $nodeVersion = (& $node.Source --version | Select-Object -First 1).Trim()
    $gitVersion = (& $git.Source --version | Select-Object -First 1).Trim()
    $vsCodeVersion = @(& $code.Source --version | Select-Object -First 1 | ForEach-Object { $_.Trim() })[0]
    $report = [ordered]@{
        result = 'passed'
        startedAtUtc = $startedAt.ToString('o')
        completedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
        windows = [ordered]@{
            productName = $windowsProductName
            registryProductName = $windows.ProductName
            displayVersion = $windows.DisplayVersion
            build = $windows.CurrentBuildNumber
            revision = $windows.UBR
            architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
        }
        node = $nodeVersion
        npm = $npmVersion
        python = $pythonVersion
        git = $gitVersion
        sourceCommit = $gitCommit
        sourceWorkingTreeDirty = ($gitStatus.Count -gt 0)
        visualStudioCode = $vsCodeVersion
        extensionVersion = $manifest.version
        extensionIdentifier = $manifest.publisher + '.' + $manifest.name
        vsixPath = Get-RepositoryRelativePath $vsixPath
        vsixSha256 = (Get-FileHash -LiteralPath $vsixPath -Algorithm SHA256).Hash.ToLowerInvariant()
        tests = [ordered]@{
            npmTest = 'passed'
            installerTests = 'passed'
            windowsFixtures = 'passed'
            isolatedVsCodeInstall = 'passed'
            vsixVerification = 'passed'
        }
        verification = @('npm test', 'Unicode and space-containing Git workspace', 'mixed CRLF and LF file', 'junction creation and installer rejection', 'VSIX build', 'isolated VS Code CLI installation')
    }
    $reportDirectory = Join-Path $repositoryRoot 'dist'
    New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
    $reportPath = Join-Path $reportDirectory ('windows-acceptance-' + $windows.CurrentBuildNumber + '.json')
    [System.IO.File]::WriteAllText($reportPath, (($report | ConvertTo-Json -Depth 6) + "`n"), $utf8)
    Write-Output ('Windows acceptance passed. VSIX SHA-256: ' + $report.vsixSha256)
    Write-Output ('Evidence: ' + (Get-RepositoryRelativePath $reportPath))
} finally {
    Set-Location -LiteralPath $originalLocation
    $resolvedTemporaryRoot = [System.IO.Path]::GetFullPath($temporaryRoot)
    if ($resolvedTemporaryRoot.StartsWith($temporaryParent, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Parent $resolvedTemporaryRoot) -eq $temporaryParent.TrimEnd([System.IO.Path]::DirectorySeparatorChar)) {
        Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
