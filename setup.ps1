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

# Live two-stage pipeline (/live): streaming ASR, final ASR, fast MT. Every file is pinned by sha256.
function Get-Pinned($url, $out, $sha) {
  if ((Test-Path $out) -and (Get-FileHash $out -Algorithm SHA256).Hash -eq $sha) { return }
  New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
  Write-Host "Downloading $(Split-Path $out -Leaf)..."
  Invoke-WebRequest $url -OutFile "$out.part"
  $got = (Get-FileHash "$out.part" -Algorithm SHA256).Hash
  if ($got -ne $sha) { Remove-Item "$out.part"; throw "sha256 mismatch for $out (got $got)" }
  Move-Item -Force "$out.part" $out
}
$m = Join-Path $root 'models'
$hf = 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-streaming-fast-conformer-ctc-en-80ms-int8/resolve/2253b9ace8a22074f5e5f0fe9102c248185c34dd'
Get-Pinned "$hf/model.int8.onnx" "$m\streaming-ctc\model.int8.onnx" 'BF402C371A293707E90413C5DF85484C8BC3AAA7081289C0007AAB5EE8AC8E22'
Get-Pinned "$hf/tokens.txt" "$m\streaming-ctc\tokens.txt" '618DC110FC2213886B52E063FF42329BBDF37A266CA7705184090FA5F39F3131'

$pk = "$m\parakeet-110m"
if (-not (Test-Path "$pk\model.int8.onnx")) {
  # only published as a .tar.bz2. Windows' own tar.exe hangs on this one (tested); Git for Windows' tar + bzip2 takes ~60 s.
  $gitUsr = Join-Path $env:ProgramFiles 'Git\usr\bin'
  if (-not (Test-Path "$gitUsr\bzip2.exe")) { throw "Need Git for Windows ($gitUsr\tar.exe + bzip2.exe) to unpack the Parakeet model" }
  $tmp = Join-Path $root 'vendor\parakeet-tmp'
  Get-Pinned 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.bz2' "$tmp\p.tar.bz2" '17F945007B52CCD8B7200FFC7C5652E9E8E961DFDF479CEFCABD06CF5703630B'
  $oldPath = $env:PATH; $env:PATH = "$gitUsr;$env:PATH"
  Push-Location $tmp; try { & "$gitUsr\tar.exe" -xjf p.tar.bz2 } finally { Pop-Location; $env:PATH = $oldPath }
  if ($LASTEXITCODE) { throw 'tar failed on the Parakeet archive' }
  New-Item -ItemType Directory -Force $pk | Out-Null
  Move-Item "$tmp\sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8\model.int8.onnx", "$tmp\sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8\tokens.txt" $pk
  Remove-Item -Recurse -Force $tmp
}
foreach ($f in @(
    @('model.int8.onnx', '9177A9146CF32EE0CC8152276EF95116F312018D316BE37CCF57F7EFEA81FC1A'),
    @('tokens.txt', '450E56BD2F036FE5B6AA821865838CC5AA9D8B0106134CE9A9BA0664ABE6CD10'))) {
  if ((Get-FileHash "$pk\$($f[0])" -Algorithm SHA256).Hash -ne $f[1]) { throw "sha256 mismatch for $pk\$($f[0])" }
}

# Bergamot en->zh-Hans 2.2: the model Firefox ships, from Mozilla's remote-settings CDN
$moz = 'https://firefox-settings-attachments.cdn.mozilla.net/main-workspace/translations-models'
Get-Pinned "$moz/a7ff7d5e-e67e-406c-a34b-a7edea35b10e.bin" "$m\bergamot-enzh\model.enzh.intgemm.alphas.bin" '4E5ACCC141373565DDC8FA1565BCEAA8D0C3482A82CAB8131C719EBCC6C2157C'
Get-Pinned "$moz/da8fccc0-31df-4665-9703-96d36606e019.bin" "$m\bergamot-enzh\lex.50.50.enzh.s2t.bin" '4A5E5827788060F1D718A8132B69440929387514A045796E9B77F935DB68C055'
Get-Pinned "$moz/ea98c52c-58dc-45d5-af23-38f2b029d020.spm" "$m\bergamot-enzh\srcvocab.enzh.spm" 'BD9B65504ACC6D9726DD281F7DEFC2ADB7C2C22D0688FE2F84697DE25197C8C5'
Get-Pinned "$moz/bddbda68-d4d2-4317-a0a1-119caa47525e.spm" "$m\bergamot-enzh\trgvocab.enzh.spm" 'ADED6993C36E440284D11CEC3F6B8AEF9C0E43188A772D80BE342A713ADF223D'

$bench = if ($env:VENDOR_BENCH_DIR) { $env:VENDOR_BENCH_DIR } else { Join-Path $root '..\bench' }
foreach ($f in 'llama-server.exe', 'Hy-MT2-Q4.gguf') {
  if (-not (Test-Path (Join-Path $bench $f))) { throw "Missing $f in $bench (set VENDOR_BENCH_DIR)" }
}

if (-not (Test-Path (Join-Path $root 'node_modules\ws'))) { Push-Location $root; npm install; Pop-Location }
Write-Host "OK. whisper: $whisperDir\Release  llama: $(Resolve-Path $bench)"
