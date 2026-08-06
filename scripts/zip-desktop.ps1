# Zip the fast desktop folder and the optional single-file exe for distribution.
$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$electronOut = Join-Path $root "dist\electron"
$unpacked = Join-Path $electronOut "win-unpacked"
$folderZip = Join-Path $electronOut "Pi Studio-desktop-win-x64.zip"
$singleZip = Join-Path $electronOut "Pi Studio-single-exe-win-x64.zip"
$singleExeFile = Get-ChildItem -LiteralPath $electronOut -Filter "*.exe" |
  Where-Object { $_.Name -ne "Pi Studio.exe" } |
  Select-Object -First 1
$readmeFile = Get-ChildItem -LiteralPath (Join-Path $root "portable") -Filter "*.txt" |
  Select-Object -First 1

Add-Type -AssemblyName System.IO.Compression.FileSystem

$stage = Join-Path $electronOut "zip-stage"
if (Test-Path -LiteralPath $stage) {
  Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stage | Out-Null

if (Test-Path -LiteralPath $folderZip) {
  Remove-Item -LiteralPath $folderZip -Force
}
Write-Host "==> Zipping fast desktop folder (win-unpacked)..."
robocopy $unpacked $stage /E /XD data workspace /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy win-unpacked staging failed with exit code $LASTEXITCODE" }
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $stage,
  $folderZip,
  [System.IO.Compression.CompressionLevel]::Optimal,
  $false
)
Remove-Item -LiteralPath $stage -Recurse -Force
Write-Host "==> Desktop folder zip ready: $folderZip"

if ($singleExeFile -and $readmeFile) {
  $singleExe = $singleExeFile.FullName
  $readme = $readmeFile.FullName
  if (Test-Path -LiteralPath $singleZip) {
    Remove-Item -LiteralPath $singleZip -Force
  }
  Write-Host "==> Zipping optional single-file exe..."
  $zip = [System.IO.Compression.ZipFile]::Open(
    $singleZip,
    [System.IO.Compression.ZipArchiveMode]::Create
  )
  try {
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $zip,
      $singleExe,
      $singleExeFile.Name,
      [System.IO.Compression.CompressionLevel]::Optimal
    )
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $zip,
      $readme,
      $readmeFile.Name,
      [System.IO.Compression.CompressionLevel]::Optimal
    )
  } finally {
    $zip.Dispose()
  }
  Write-Host "==> Single-file exe zip ready: $singleZip"
}
