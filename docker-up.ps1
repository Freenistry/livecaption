# Windows: native llama-server (Hy-MT2 on the GPU via Vulkan) on 0.0.0.0:8099 + the Docker stack using it, then opens the app.
# Usage: .\docker-up.ps1           start (or reuse) everything and open http://localhost:3000
#        .\docker-up.ps1 -Down     stop the containers and the llama-server this script started
#        .\docker-up.ps1 -Tunnel   also a Cloudflare tunnel to the Elixir server, so room listeners can join from the internet
#                                  (needs $env:APP_TOKEN; $env:TUNNEL_TOKEN = your named tunnel, else a quick trycloudflare.com URL)
param([switch]$Down, [switch]$Tunnel)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$bench = if ($env:VENDOR_BENCH_DIR) { $env:VENDOR_BENCH_DIR } else { Join-Path $root '..\bench' }
$data = Join-Path $root 'data'; New-Item -ItemType Directory -Force $data | Out-Null
$pidFile = Join-Path $data 'host-llama.pid'
# docker prints progress on stderr, which Windows PowerShell 5.1 turns into errors: run it through cmd, check the exit code
$files = "-f `"$root\docker-compose.yml`" -f `"$root\docker-compose.host-llm.yml`""
if ($Tunnel) { $files += " -f `"$root\docker-compose.tunnel.yml`" --profile $(if ($env:TUNNEL_TOKEN) { 'named' } else { 'quick' })" }
function Compose([string]$a) {
  cmd /c "docker compose $files $a 2>&1" | Out-Host
  $LASTEXITCODE
}

if ($Down) {
  Compose 'down --remove-orphans' | Out-Null
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
if ($Tunnel -and -not $env:TUNNEL_TOKEN) {
  $deadline = (Get-Date).AddSeconds(60)
  do { Start-Sleep -Seconds 1; $u = (cmd /c "docker compose $files logs quick 2>&1" | Select-String -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -Last 1).Matches.Value } until ($u -or (Get-Date) -gt $deadline)
  if (-not $u) { throw 'no tunnel URL after 60 s; see: docker compose logs quick' }
  Write-Host "public: speaker $u/?room=<name>&token=<APP_TOKEN>   listeners $u/r/<name>"
} elseif ($Tunnel) { Write-Host 'public: the hostname you set on the named tunnel (Cloudflare Zero Trust > Networks > Tunnels)' }
Start-Process 'http://localhost:3000'
