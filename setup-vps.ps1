# Scalp Base MCP - Full VPS Setup (PowerShell Admin)
# Paste this entire block. One and done.

Write-Host "=== Scalp Bot VPS Setup ===" -ForegroundColor Cyan

# 1. Install Node if needed
try { node --version 2>$null } catch {
    Write-Host "[1/4] Installing Node.js..." -ForegroundColor Yellow
    $url = "https://nodejs.org/dist/v24.6.0/node-v24.6.0-win-x64.zip"
    Invoke-WebRequest -Uri $url -OutFile "$env:TEMP\node.zip"
    Expand-Archive -Path "$env:TEMP\node.zip" -DestinationPath "C:\nodejs" -Force
    $env:Path = "C:\nodejs\node-v24.6.0-win-x64;$env:Path"
    [Environment]::SetEnvironmentVariable("Path", "C:\nodejs\node-v24.6.0-win-x64;$env:Path", "Machine")
    Write-Host "Node.js installed." -ForegroundColor Green
} 
Write-Host "[1/4] Node: $(node --version)" -ForegroundColor Green

# 2. Clone repo
Write-Host "[2/4] Cloning repo..." -ForegroundColor Yellow
cd C:\
if (Test-Path "C:\scalp-base-mcp") { cd C:\scalp-base-mcp; git pull } else { git clone https://github.com/jepspows/scalp-base-mcp.git }

# 3. Install deps
Write-Host "[3/4] Installing dependencies..." -ForegroundColor Yellow
cd C:\scalp-base-mcp\server
npm install

# 4. Create start script
@"
cd C:\scalp-base-mcp\server
node server.js >> C:\scalp-base-mcp\server\bot.log 2>&1
"@ | Out-File -FilePath "C:\scalp-base-mcp\start.bat" -Encoding ASCII

# 5. Scheduled task (auto-start on boot)
$action = New-ScheduledTaskAction -Execute "C:\scalp-base-mcp\start.bat"
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "ScalpBot" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

# 6. Start now
Write-Host "[4/4] Starting scalp bot..." -ForegroundColor Yellow
Start-Process -FilePath "C:\scalp-base-mcp\start.bat" -WindowStyle Hidden
Start-Sleep -Seconds 5

# 7. Verify
$health = Invoke-RestMethod -Uri "http://localhost:3002/health" -ErrorAction SilentlyContinue
if ($health) {
    Write-Host "`nSERVER LIVE!" -ForegroundColor Green
    Write-Host "Candles: $($health.candles) | Leverage: $($health.leverage)x | TP: $($health.tpPct*100)% | SL: $($health.slPct*100)%"
    Write-Host "`nCheck signals: http://localhost:3002/v1/signal"
    Write-Host "Check paper PnL: http://localhost:3002/v1/history"
    Write-Host "`nBot runs 24/7. Auto-restarts on reboot. Logs at C:\scalp-base-mcp\server\bot.log"
} else {
    Write-Host "`nServer may still be starting. Check C:\scalp-base-mcp\server\bot.log" -ForegroundColor Yellow
}
