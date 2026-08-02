[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Aicl-Lifecycle.ps1')

$repositoryRoot = Get-AiclRepositoryRoot
$buildRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot 'build\production'))
$expectedPrefix = $repositoryRoot.TrimEnd('\') + '\'
if (-not $buildRoot.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to clean a production build path outside the repository.'
}
if (Test-Path -LiteralPath $buildRoot) {
    Remove-Item -LiteralPath $buildRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null

Push-Location $repositoryRoot
try {
    & pnpm --filter '@aicl/web' build
    if ($LASTEXITCODE -ne 0) {
        throw 'Web production build failed.'
    }

    $bundleArguments = @(
        '--bundle',
        '--platform=node',
        '--target=node24',
        '--format=esm',
        '--log-level=warning',
        "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
    )
    $entries = @(
        @('apps/core/src/main.ts', 'apps/core/src/main.mjs'),
        @('apps/connector/src/main.ts', 'apps/connector/src/main.mjs'),
        @('apps/host/src/supervisor.ts', 'apps/host/supervisor.mjs'),
        @('apps/host/src/doctor.ts', 'apps/host/doctor.mjs')
    )
    foreach ($entry in $entries) {
        $outputPath = Join-Path $buildRoot $entry[1]
        New-Item -ItemType Directory -Path (Split-Path -Parent $outputPath) `
            -Force | Out-Null
        & pnpm exec esbuild $entry[0] @bundleArguments "--outfile=$outputPath"
        if ($LASTEXITCODE -ne 0) {
            throw "Production bundle failed: $($entry[0])"
        }
    }

    Copy-Item -LiteralPath '.\apps\core\migrations' `
        -Destination (Join-Path $buildRoot 'apps\core\migrations') -Recurse
    Copy-Item -LiteralPath '.\apps\connector\migrations' `
        -Destination (Join-Path $buildRoot 'apps\connector\migrations') -Recurse
    Copy-Item -LiteralPath '.\apps\web\dist' `
        -Destination (Join-Path $buildRoot 'apps\web\dist') -Recurse

    $commit = (& git rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -ne 0) {
        $commit = 'unavailable'
    }
    $buildInfo = [ordered]@{
        version = 1
        builtAt = [DateTime]::UtcNow.ToString('o')
        node = (& node --version)
        commit = $commit
    }
    $buildInfo | ConvertTo-Json | Set-Content `
        -LiteralPath (Join-Path $buildRoot 'build-info.json') -Encoding UTF8
}
finally {
    Pop-Location
}

Write-Host "Production build ready: $buildRoot"
