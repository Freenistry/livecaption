# Windows: native llama-server (Hy-MT2 on the GPU via Vulkan) on 0.0.0.0:8099 + the Docker stack using it, then opens the app.
# Usage: .\docker-up.ps1           start (or reuse) everything and open http://localhost:3000
#        .\docker-up.ps1 -Down     stop the containers and the llama-server this script started
param([switch]$Down)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$bench = if ($env:VENDOR_BENCH_DIR) { $env:VENDOR_BENCH_DIR } else { Join-Path $root '..\bench' }
$data = Join-Path $root 'data'; New-Item -ItemType Directory -Force $data | Out-Null
$pidFile = Join-Path $data 'host-llama.pid'
# docker prints progress on stderr, which Windows PowerShell 5.1 turns into errors: run it through cmd, check the exit code
function Compose([string]$a) {
  cmd /c "docker compose -f `"$root\docker-compose.yml`" -f `"$root\docker-compose.host-llm.yml`" $a 2>&1" | Out-Host
  $LASTEXITCODE
}

if ($Down) {
  Compose 'down' | Out-Null
  if (Test-Path $pidFile) { Stop-Process -Id (Get-Content $pidFile) -Force -ErrorAction SilentlyContinue; Remove-Item $pidFile }
  Write-Host 'stopped'; exit 0
}

function Up($url) { try { Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 2 | Out-Null; $true } catch { $false } }

if (-not (Up 'http://127.0.0.1:8099/health')) {
  foreach ($f in 'llama-server.exe', 'Hy-MT2-Q4.gguf') { if (-not (Test-Path "$bench\$f")) { throw "Missing $f in $bench (see README step 1, or set VENDOR_BENCH_DIR)" } }
  # 0.0.0.0 so containers reach it via host.docker.internal; Windows Firewall may ask once (allow Private networks)
  $p = Start-Process -PassThru -WindowStyle Hidden "$bench\llama-server.exe" `
    -ArgumentList '-m', "`"$bench\Hy-MT2-Q4.gguf`"", '--host', '0.0.0.0', '--port', '8099', '-ngl', '99', '--jinja', '-c', '2048' `
    -RedirectStandardOutput "$data\host-llama.log" -RedirectStandardError "$data\host-llama.err.log"
  Set-Content $pidFile $p.Id
  $deadline = (Get-Date).AddSeconds(90)
  while (-not (Up 'http://127.0.0.1:8099/health')) {
    if ($p.HasExited) { throw "llama-server exited; see $data\host-llama.err.log" }
    if ((Get-Date) -gt $deadline) { throw 'llama-server not ready after 90 s' }
    Start-Sleep -Milliseconds 500
  }
  Write-Host "llama-server on the GPU: http://127.0.0.1:8099 (pid $($p.Id))"
} else { Write-Host 'reusing the llama-server already on :8099' }

if (Compose 'up -d --build --remove-orphans') { throw 'docker compose up failed' }
$deadline = (Get-Date).AddSeconds(180)
while (-not (Up 'http://127.0.0.1:3000/api/languages')) {
  if ((Get-Date) -gt $deadline) { throw 'app not ready after 180 s; see: docker compose logs node' }
  Start-Sleep -Seconds 1
}
Write-Host 'ready: http://localhost:3000 (Node)  http://localhost:3001 (Elixir)'
Start-Process 'http://localhost:3000'
