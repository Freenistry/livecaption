# Start whisper-server (:8081) + llama-server (:8099), wait for health, run node. Ctrl+C kills all.
# Usage: .\start.ps1 -SourceLang es -TargetLang "Simplified Chinese"   (pair for the first version, /)
#        .\start.ps1 -Gpu                                               (/live: non-English speech model on the GPU)
# Omit the flags to fall back to SOURCE_LANG/TARGET_LANG from the environment, then to auto/German.
param(
  [string]$SourceLang = $(if ($env:SOURCE_LANG) { $env:SOURCE_LANG } else { 'auto' }),
  [string]$TargetLang = $(if ($env:TARGET_LANG) { $env:TARGET_LANG } else { 'German' }),
  [switch]$Gpu  # needs setup.ps1 -Gpu; the speech model takes ~1 min to load
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$bench = if ($env:VENDOR_BENCH_DIR) { $env:VENDOR_BENCH_DIR } else { Join-Path $root '..\bench' }
$data = Join-Path $root 'data'
New-Item -ItemType Directory -Force $data | Out-Null

# Node reads these; whisper gets -l auto and detects per request unless SOURCE_LANG pins it.
$env:SOURCE_LANG = $SourceLang
$env:TARGET_LANG = $TargetLang
$env:ASR_GPU = if ($Gpu) { '1' } else { '' }
Write-Host "language pair: $SourceLang -> $TargetLang"

$procs = @()
try {
  $procs += Start-Process -PassThru -WindowStyle Hidden "$root\vendor\whisper\Release\whisper-server.exe" `
    -ArgumentList '-m', "`"$root\models\ggml-base.bin`"", '--host', '127.0.0.1', '--port', '8081', '-t', '4', '-l', $SourceLang, '-ac', '512' `
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
