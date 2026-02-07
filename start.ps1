$ErrorActionPreference = "Stop"

$env:GTFS_PROXY_BASE = "http://127.0.0.1:8000"
$env:GTFS_PROXY_MODE = "nyctrains"
$env:PORT = "3001"
$env:PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION = "python"
$env:PROTOBUF_FORCE_PYTHON = "1"
$env:PYTHONPATH = (Get-Location).Path

Write-Host "Checking port 3001..."
$existing = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  $pids = $existing | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($pid in $pids) {
    try {
      $proc = Get-Process -Id $pid -ErrorAction Stop
      Write-Host "Stopping process on 3001: $($proc.ProcessName) (PID $pid)"
      Stop-Process -Id $pid -Force
    } catch {
      Write-Host "Could not stop PID $pid (may have exited)."
    }
  }
}

Write-Host "Starting Python proxy on http://127.0.0.1:8000"
$proxyProcess = $null
$proxyExisting = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
if ($proxyExisting) {
  Write-Host "Proxy already running on port 8000."
} else {
  $proxyProcess = Start-Process -FilePath "py" -ArgumentList "proxy\run_proxy.py" -PassThru -WindowStyle Hidden
}

Start-Sleep -Seconds 2

$proxyReady = $false
for ($i = 0; $i -lt 6; $i++) {
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8000/subway/bdfm/json" -TimeoutSec 3
    if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500) {
      $proxyReady = $true
      break
    }
  } catch {
    Start-Sleep -Seconds 1
  }
}

if (-not $proxyReady) {
  Write-Host "Proxy is not responding on 127.0.0.1:8000."
  Write-Host "Try: py -m pip install -r proxy\requirements.txt"
  if ($proxyProcess -and !$proxyProcess.HasExited) {
    Stop-Process -Id $proxyProcess.Id
  }
  exit 1
}

Write-Host "Starting Node backend on http://localhost:3001"
node "backend\server.js"

if ($proxyProcess -and !$proxyProcess.HasExited) {
  Stop-Process -Id $proxyProcess.Id
}
