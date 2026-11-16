# Start whisper-server (:8081) + llama-server (:8099), wait for health, run node. Ctrl+C kills all.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$bench = if ($env:VENDOR_BENCH_DIR) { $env:VENDOR_BENCH_DIR } else { Join-Path $root '..\bench' }
$data = Join-Path $root 'data'
New-Item -ItemType Directory -Force $data | Out-Null

$procs = @()
try {
  $procs += Start-Process -PassThru -WindowStyle Hidden "$root\vendor\whisper\Release\whisper-server.exe" `
    -ArgumentList '-m', "`"$root\models\ggml-base.bin`"", '--host', '127.0.0.1', '--port', '8081', '-t', '4', '-l', 'auto', '-ac', '512' `
    -RedirectStandardOutput "$data\whisper.log" -RedirectStandardError "$data\whisper.err.log"
  $procs += Start-Process -PassThru -WindowStyle Hidden "$bench\llama-server.exe" `
    -ArgumentList '-m', "`"$bench\Hy-MT2-Q4.gguf`"", '--host', '127.0.0.1', '--port', '8099', '-ngl', '99', '--jinja', '-c', '2048' `
    -RedirectStandardOutput "$data\llama.log" -RedirectStandardError "$data\llama.err.log"

  foreach ($u in 'http://127.0.0.1:8081/', 'http://127.0.0.1:8099/health') {
    $deadline = (Get-Date).AddSeconds(60)
    while ($true) {
      try { Invoke-WebRequest $u -UseBasicParsing -TimeoutSec 2 | Out-Null; break } catch {}
      if ($procs | Where-Object HasExited) { throw "A backend exited early; see $data\*.log" }
      if ((Get-Date) -gt $deadline) { throw "Timed out waiting for $u" }
      Start-Sleep -Milliseconds 500
    }
    Write-Host "ready: $u"
  }
  node "$root\server.js"
} finally {
  $procs | Where-Object { -not $_.HasExited } | ForEach-Object { Stop-Process -Id $_.Id -Force }
  Write-Host 'backends stopped'
}
