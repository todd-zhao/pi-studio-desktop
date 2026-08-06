@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "APP_ROOT=%~dp0"
if "%APP_ROOT:~-1%"=="\" set "APP_ROOT=%APP_ROOT:~0,-1%"

set "PI_CODING_AGENT_DIR=%APP_ROOT%\data\pi-agent"
set "PI_STUDIO_WORKSPACE=%APP_ROOT%\workspace"
set "PI_STUDIO_PORT=8787"
set "PI_STUDIO_LOAD_GLOBAL_EXTENSIONS=0"
set "PI_OFFLINE=1"

title Pi Studio

echo ============================================
echo   Pi Studio (portable)
echo   Data folder : %APP_ROOT%\data
echo   Workspace   : %APP_ROOT%\workspace
echo   Press Ctrl+C to stop.
echo ============================================
echo.

start "Pi Studio browser" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$url='http://localhost:8787'; for($i=0;$i -lt 180;$i++){ try { $r=Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 1; if($r.StatusCode -eq 200){ Start-Process $url; break } } catch { } Start-Sleep -Milliseconds 500 }"

"runtime\node.exe" "server\dist\index.mjs"
set "NODE_EXIT=%ERRORLEVEL%"

if not "%NODE_EXIT%"=="0" (
  echo.
  echo Pi Studio may already be running.
  start http://localhost:8787
  echo Visit http://localhost:8787 in your browser.
  echo Close the existing Pi Studio window before starting again.
)

echo.
pause
