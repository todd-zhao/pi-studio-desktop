# Build the portable "Pi Studio" folder with an embedded Node runtime.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-portable.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-portable.ps1 -Zip

param(
  [switch]$Zip
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$nodeVersion = "v24.12.0"
$nodeDirName = "node-$nodeVersion-win-x64"
$nodeZipName = "$nodeDirName.zip"
$nodeUrl = "https://nodejs.org/dist/$nodeVersion/$nodeZipName"

$cacheDir = Join-Path $root ".cache\node"
$nodeZipPath = Join-Path $cacheDir $nodeZipName
$nodeExtractDir = Join-Path $cacheDir $nodeDirName
$portableRoot = Join-Path $root "dist\portable"
$appName = "Pi Studio"
$appDir = Join-Path $portableRoot $appName
$runtimeDir = Join-Path $appDir "runtime"
$depsStage = Join-Path $root ".desktop-package-stage\runtime-deps"
$runtimeNpmCache = Join-Path $root ".cache\npm-runtime"

Write-Host "==> Building client (Vite)..."
Push-Location $root
try {
  npm run build:client
  if ($LASTEXITCODE -ne 0) { throw "npm run build:client failed" }

  Write-Host "==> Building server..."
  npm run build:server
  if ($LASTEXITCODE -ne 0) { throw "npm run build:server failed" }
} finally {
  Pop-Location
}

Write-Host "==> Ensuring Node $nodeVersion runtime..."
if (-not (Test-Path $nodeZipPath)) {
  New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
  Write-Host "    Downloading $nodeUrl"
  if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    & curl.exe -L --fail --silent --show-error -o $nodeZipPath $nodeUrl
    if ($LASTEXITCODE -ne 0) { throw "Node download failed" }
  } else {
    Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZipPath -UseBasicParsing
  }
}
if (-not (Test-Path (Join-Path $nodeExtractDir "node.exe"))) {
  Write-Host "    Extracting $nodeZipName"
  Expand-Archive -Path $nodeZipPath -DestinationPath $cacheDir -Force
}

Write-Host "==> Assembling $appDir ..."
if (Test-Path $appDir) {
  Remove-Item -LiteralPath $appDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $appDir "workspace") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $appDir "data") | Out-Null
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

Copy-Item (Join-Path $nodeExtractDir "node.exe") (Join-Path $runtimeDir "node.exe")

Write-Host "==> Installing production-only runtime dependencies..."
if (Test-Path -LiteralPath $depsStage) {
  Remove-Item -LiteralPath $depsStage -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $depsStage "server") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $depsStage "client") | Out-Null
Copy-Item (Join-Path $root "package.json") (Join-Path $depsStage "package.json")
Copy-Item (Join-Path $root "package-lock.json") (Join-Path $depsStage "package-lock.json")
Copy-Item (Join-Path $root "server\package.json") (Join-Path $depsStage "server\package.json")
Copy-Item (Join-Path $root "client\package.json") (Join-Path $depsStage "client\package.json")
Push-Location $depsStage
try {
  npm ci --omit=dev --workspace server --ignore-scripts --no-audit --no-fund --cache $runtimeNpmCache
  if ($LASTEXITCODE -ne 0) { throw "production dependency install failed" }
  # Hermes Memory uses better-sqlite3. npm ci above intentionally skips all
  # install scripts, so rebuild only this native addon for the bundled Node.
  npm rebuild --workspace server better-sqlite3 --no-audit --no-fund --cache $runtimeNpmCache
  if ($LASTEXITCODE -ne 0) { throw "better-sqlite3 rebuild failed" }
} finally {
  Pop-Location
}

Write-Host "==> Replacing vulnerable dependencies bundled by the Pi SDK..."
& node (Join-Path $root "scripts\patch-pi-bundled-deps.cjs") (Join-Path $depsStage "node_modules")
if ($LASTEXITCODE -ne 0) { throw "Pi bundled dependency patch failed" }

Write-Host "==> Removing runtime-inert maps and type declarations..."
$runtimeModules = Join-Path $depsStage "node_modules"
Get-ChildItem -Path $runtimeModules -Recurse -File -Include "*.map", "*.d.ts", "*.d.mts", "*.d.cts" |
  Remove-Item -Force
$runtimeTypes = Join-Path $runtimeModules "@types"
if (Test-Path -LiteralPath $runtimeTypes) {
  Remove-Item -LiteralPath $runtimeTypes -Recurse -Force
}

robocopy (Join-Path $depsStage "node_modules") (Join-Path $appDir "node_modules") /E /MT:16 /R:1 /W:1 /XD pi-studio-client pi-studio-server /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy node_modules failed with exit code $LASTEXITCODE" }

robocopy (Join-Path $root "server\dist") (Join-Path $appDir "server\dist") /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy server/dist failed with exit code $LASTEXITCODE" }

robocopy (Join-Path $root "client\dist") (Join-Path $appDir "client\dist") /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy client/dist failed with exit code $LASTEXITCODE" }

$portableSourceDir = Join-Path $root "portable"
$launcherFile = Get-ChildItem -LiteralPath $portableSourceDir -Filter "*.bat" | Select-Object -First 1
$readmeFile = Get-ChildItem -LiteralPath $portableSourceDir -Filter "*.txt" | Select-Object -First 1
Copy-Item -LiteralPath $launcherFile.FullName (Join-Path $appDir $launcherFile.Name)
if ($readmeFile) {
  Copy-Item -LiteralPath $readmeFile.FullName (Join-Path $appDir $readmeFile.Name)
}

$sizeMb = [math]::Round(((Get-ChildItem $appDir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
Write-Host "==> Portable app ready: $appDir ($sizeMb MB)"

if ($Zip) {
  $zipPath = Join-Path $portableRoot "$appName-portable-win-x64.zip"
  if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  Write-Host "==> Zipping (this can take a few minutes)..."
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory($appDir, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)
  Write-Host "==> Zip ready: $zipPath"
}
