# Fetch whisper.cpp binaries + model if missing, check the llama-server/GGUF location.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$ProgressPreference = 'SilentlyContinue'  # makes Invoke-WebRequest much faster

$whisperDir = Join-Path $root 'vendor\whisper'
if (-not (Test-Path "$whisperDir\Release\whisper-server.exe")) {
  New-Item -ItemType Directory -Force $whisperDir | Out-Null
  $zip = Join-Path $root 'vendor\whisper.zip'
  Write-Host 'Downloading whisper.cpp b5454 (CPU/BLAS x64)...'
  Invoke-WebRequest 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-blas-bin-x64.zip' -OutFile $zip
  Expand-Archive $zip $whisperDir -Force
}

$model = Join-Path $root 'models\ggml-base.bin'
if (-not (Test-Path $model)) {
  New-Item -ItemType Directory -Force (Split-Path $model) | Out-Null
  Write-Host 'Downloading ggml-base.bin (141 MB)...'
  Invoke-WebRequest 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin' -OutFile $model
}

$bench = if ($env:VENDOR_BENCH_DIR) { $env:VENDOR_BENCH_DIR } else { Join-Path $root '..\bench' }
foreach ($f in 'llama-server.exe', 'Hy-MT2-Q4.gguf') {
  if (-not (Test-Path (Join-Path $bench $f))) { throw "Missing $f in $bench (set VENDOR_BENCH_DIR)" }
}

if (-not (Test-Path (Join-Path $root 'node_modules\ws'))) { Push-Location $root; npm install; Pop-Location }
Write-Host "OK. whisper: $whisperDir\Release  llama: $(Resolve-Path $bench)"
