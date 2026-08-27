param(
  [string]$Version = "v0.5.10-beta.1"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$SourceDirectory = Join-Path $ProjectRoot "youtube-archive-queue"
$DistDirectory = Join-Path $ProjectRoot "dist"
$StageDirectory = Join-Path $DistDirectory "youtube-archive-queue"
$ArchivePath = Join-Path $DistDirectory "youtube-archive-queue-$Version.zip"

if (-not (Test-Path -LiteralPath $SourceDirectory -PathType Container)) {
  throw "Extension directory not found: $SourceDirectory"
}

if (Test-Path -LiteralPath $DistDirectory) {
  Remove-Item -LiteralPath $DistDirectory -Recurse -Force
}

New-Item -ItemType Directory -Path $StageDirectory -Force | Out-Null
Copy-Item -Path (Join-Path $SourceDirectory "*") -Destination $StageDirectory -Recurse -Force
Compress-Archive -Path $StageDirectory -DestinationPath $ArchivePath -CompressionLevel Optimal

Write-Output $ArchivePath
