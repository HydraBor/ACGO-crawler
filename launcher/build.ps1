[CmdletBinding()]
param(
  [switch]$SkipRuntime,
  [switch]$SkipDistributionZip
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$launcherRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$binRoot = [IO.Path]::GetFullPath((Join-Path $launcherRoot 'bin'))
$distParent = [IO.Path]::GetFullPath((Join-Path $projectRoot 'dist'))
$distRoot = [IO.Path]::GetFullPath((Join-Path $distParent 'ACGO-Crawler'))

function Assert-ProjectChild([string]$PathToCheck) {
  $projectPrefix = $projectRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $PathToCheck.StartsWith($projectPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to operate outside project root: $PathToCheck"
  }
}

function Get-Sha256([string]$Filename) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($Filename)
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  }
  finally {
    $stream.Dispose()
    $algorithm.Dispose()
  }
}

Assert-ProjectChild $binRoot
Assert-ProjectChild $distParent
Assert-ProjectChild $distRoot

& node (Join-Path $projectRoot 'scripts\check-release.mjs')
if ($LASTEXITCODE -ne 0) { throw "2.0 release checks failed with exit code $LASTEXITCODE." }

$cscCandidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) {
  throw 'Windows .NET Framework C# compiler (csc.exe) was not found.'
}

if (Test-Path -LiteralPath $binRoot) { Remove-Item -LiteralPath $binRoot -Recurse -Force }
New-Item -ItemType Directory -Path $binRoot | Out-Null
$launcherExe = Join-Path $binRoot 'ACGO-Crawler-Launcher.exe'
$source = Join-Path $launcherRoot 'AcgoCrawlerLauncher.cs'

$compilerArguments = @(
  '/nologo',
  '/target:winexe',
  '/platform:x64',
  '/optimize+',
  "/out:$launcherExe",
  '/reference:System.dll',
  '/reference:System.Core.dll',
  '/reference:System.Drawing.dll',
  '/reference:System.Windows.Forms.dll',
  '/reference:System.IO.Compression.dll',
  '/reference:System.IO.Compression.FileSystem.dll',
  $source
)
& $csc $compilerArguments
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcherExe)) {
  throw "Launcher compilation failed with exit code $LASTEXITCODE."
}

if (Test-Path -LiteralPath $distRoot) { Remove-Item -LiteralPath $distRoot -Recurse -Force }
New-Item -ItemType Directory -Path $distRoot | Out-Null

foreach ($directoryName in @('src', 'node_modules', 'docs', 'scripts')) {
  $sourceDirectory = Join-Path $projectRoot $directoryName
  if (-not (Test-Path -LiteralPath $sourceDirectory)) { throw "Required release directory is missing: $sourceDirectory" }
  Copy-Item -LiteralPath $sourceDirectory -Destination (Join-Path $distRoot $directoryName) -Recurse
}

foreach ($fileName in @('package.json', 'package-lock.json', 'README.md', 'LICENSE', 'config.example.json')) {
  $sourceFile = Join-Path $projectRoot $fileName
  if (Test-Path -LiteralPath $sourceFile) { Copy-Item -LiteralPath $sourceFile -Destination $distRoot }
}
$requiredPrompt = Join-Path $projectRoot ([string]([char]0x63D0) + [char]0x793A + [char]0x8BCD + '.md')
if (-not (Test-Path -LiteralPath $requiredPrompt)) { throw "Required root prompt file is missing: $requiredPrompt" }
if ([string]::IsNullOrWhiteSpace([IO.File]::ReadAllText($requiredPrompt))) { throw "Required root prompt file is empty: $requiredPrompt" }
Copy-Item -LiteralPath $requiredPrompt -Destination $distRoot
Copy-Item -LiteralPath $launcherExe -Destination (Join-Path $distRoot 'ACGO-Crawler-Launcher.exe')

if (-not $SkipRuntime) {
  $nodeVersion = '22.23.2'
  $archiveName = "node-v$nodeVersion-win-x64.zip"
  $cacheRoot = [IO.Path]::GetFullPath((Join-Path $launcherRoot 'cache'))
  Assert-ProjectChild $cacheRoot
  New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
  $cachedArchive = Join-Path $cacheRoot $archiveName
  $releaseBaseUrl = "https://nodejs.org/dist/v$nodeVersion"
  $checksumText = (Invoke-WebRequest -UseBasicParsing -Uri "$releaseBaseUrl/SHASUMS256.txt").Content
  $escapedArchiveName = [regex]::Escape($archiveName)
  $checksumMatch = [regex]::Match($checksumText, '(?mi)^([0-9a-f]{64})\s+' + $escapedArchiveName + '$')
  if (-not $checksumMatch.Success) { throw "Could not find $archiveName in the official Node.js checksum file." }
  $expectedHash = $checksumMatch.Groups[1].Value.ToLowerInvariant()

  $downloadNeeded = -not (Test-Path -LiteralPath $cachedArchive)
  if (-not $downloadNeeded) {
    $cachedHash = Get-Sha256 $cachedArchive
    $downloadNeeded = $cachedHash -ne $expectedHash
  }
  if ($downloadNeeded) {
    Write-Host "Downloading official Node.js $nodeVersion Windows x64 portable runtime..."
    Invoke-WebRequest -UseBasicParsing -Uri "$releaseBaseUrl/$archiveName" -OutFile $cachedArchive
  }
  $actualHash = Get-Sha256 $cachedArchive
  if ($actualHash -ne $expectedHash) { throw 'Node.js runtime SHA-256 validation failed.' }

  $runtimeRoot = Join-Path $distRoot 'runtime'
  New-Item -ItemType Directory -Path $runtimeRoot | Out-Null
  Copy-Item -LiteralPath $cachedArchive -Destination (Join-Path $runtimeRoot 'node-runtime.zip')
  Set-Content -LiteralPath (Join-Path $runtimeRoot 'node-runtime.sha256') -Value $expectedHash -Encoding Ascii -NoNewline
}

$guideSource = Join-Path $launcherRoot 'USAGE.txt'
if (Test-Path -LiteralPath $guideSource) {
  Copy-Item -LiteralPath $guideSource -Destination (Join-Path $distRoot 'USAGE.txt')
}

if (-not $SkipDistributionZip) {
  $distributionZip = Join-Path $distParent 'ACGO-Crawler-Windows-x64.zip'
  Assert-ProjectChild $distributionZip
  if (Test-Path -LiteralPath $distributionZip) { Remove-Item -LiteralPath $distributionZip -Force }
  Compress-Archive -LiteralPath $distRoot -DestinationPath $distributionZip -CompressionLevel Optimal
  Write-Host "Release archive: $distributionZip"
}

Write-Host "Launcher: $(Join-Path $distRoot 'ACGO-Crawler-Launcher.exe')"
if (Test-Path -LiteralPath $binRoot) {
  Remove-Item -LiteralPath $binRoot -Recurse -Force
}
if (-not $SkipRuntime) {
  $cacheRoot = [IO.Path]::GetFullPath((Join-Path $launcherRoot 'cache'))
  Assert-ProjectChild $cacheRoot
  if (Test-Path -LiteralPath $cacheRoot) {
    Remove-Item -LiteralPath $cacheRoot -Recurse -Force
  }
}
Write-Host 'Removed reproducible launcher/bin and launcher/cache build artifacts.'
Write-Host 'Build completed.'
