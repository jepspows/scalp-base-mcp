@echo off
echo === Scalp Base MCP - VPS Setup ===
echo.

:: Check Node
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [1/4] Installing Node.js...
    powershell -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v24.6.0/node-v24.6.0-win-x64.zip' -OutFile '%TEMP%\node.zip'" -ErrorAction Stop
    powershell -Command "Expand-Archive -Path '%TEMP%\node.zip' -DestinationPath 'C:\nodejs' -Force"
    set PATH=C:\nodejs\node-v24.6.0-win-x64;%PATH%
    echo Node.js installed.
) else (
    echo [1/4] Node.js already installed.
)

:: Clone repo
echo [2/4] Cloning scalp-base-mcp...
cd C:\
if exist "C:\scalp-base-mcp" (
    cd C:\scalp-base-mcp
    git pull
) else (
    git clone https://github.com/jepspows/scalp-base-mcp.git
)

:: Install deps
echo [3/4] Installing dependencies...
cd C:\scalp-base-mcp\server
call npm install

:: Start server
echo [4/4] Starting scalp bot...
echo.
echo Server will run in this window. Leave it open.
echo Signals start after 4 hours (VWAP warmup).
echo.
node server.js
pause
