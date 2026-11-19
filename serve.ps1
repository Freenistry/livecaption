# Runs start.ps1 (whisper + Hy-MT2 + node) hidden in the background and returns. The app: http://localhost:3000/
# Usage: .\serve.ps1            start (add -Gpu for the non-English speech model on the GPU)
#        .\serve.ps1 -Status    is it running?
#        .\serve.ps1 -Stop      stop it and every backend it started
param([switch]$Stop, [switch]$Status, [switch]$Gpu)
$ErrorActionPreference = 'Stop'
$data = Join-Path $PSScriptRoot 'data'
$pidFile = Join-Path $data 'serve.pid'
New-Item -ItemType Directory -Force $data | Out-Null
$running = if (Test-Path $pidFile) { Get-Process -Id (Get-Content $pidFile) -ErrorAction SilentlyContinue }

if ($Stop) {
  if (-not $running) { Write-Host 'not running'; Remove-Item $pidFile -ErrorAction SilentlyContinue; exit 0 }
  taskkill /T /F /PID $running.Id | Out-Null  # /T: the whole tree (powershell -> whisper, llama, node)
  Remove-Item $pidFile
  Write-Host 'stopped'; exit 0
}
if ($Status) {
  if ($running) { Write-Host "running (pid $($running.Id)), log: $data\serve.log" } else { Write-Host 'not running' }
  exit 0
}
if ($running) { Write-Host "already running (pid $($running.Id)): http://localhost:3000/"; exit 0 }

$args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSScriptRoot\start.ps1`"")
if ($Gpu) { $args += '-Gpu' }
$p = Start-Process powershell -PassThru -WindowStyle Hidden -ArgumentList $args `
  -RedirectStandardOutput "$data\serve.log" -RedirectStandardError "$data\serve.err.log"
Set-Content $pidFile $p.Id
Write-Host "starting in the background (pid $($p.Id)), log: $data\serve.log"

$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
  if ($p.HasExited) { throw "server exited early; see $data\serve.log and serve.err.log" }
  try { Invoke-WebRequest 'http://127.0.0.1:3000/api/health' -UseBasicParsing -TimeoutSec 2 | Out-Null; Write-Host 'ready: http://localhost:3000/'; exit 0 } catch {}
  Start-Sleep -Milliseconds 500
}
throw "not ready after 120 s; see $data\serve.log"
