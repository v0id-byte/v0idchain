@echo off
REM v0idChain 一键挖矿（Windows）—— 双击本文件即可。
cd /d "%~dp0"
echo ============================================
echo    v0idChain miner  $V0ID
echo ============================================
where corepack >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js not found. Install LTS from https://nodejs.org then double-click again.
  pause
  exit /b 1
)
echo Installing deps (first run is slow)...
call corepack pnpm install || (echo install failed & pause & exit /b 1)
echo Opening dashboard...
start "v0id dashboard" cmd /c "corepack pnpm dev:web"
timeout /t 3 >nul
start "" http://localhost:5173
echo Mining (connecting to mc.void1211.com seed)... close this window to stop.
call corepack pnpm mine
