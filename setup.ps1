# Fetch whisper.cpp binaries + model if missing, check the llama-server/GGUF location.
# Usage: .\setup.ps1                     English /live + the first version (/)
#        .\setup.ps1 -Langs es,de,ja     also other spoken languages on /live (Nemotron CPU model + Bergamot pairs)
#        .\setup.ps1 -Langs es -Gpu      same, with the GPU speech model (NVIDIA, ~5 GB download; run start.ps1 -Gpu)
param([string[]]$Langs = @(), [switch]$Gpu)
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

# Other spoken languages on /live: Nemotron 3.5 ASR streaming (32 languages) + Bergamot X->en per language
if ($Langs.Count) {
  $nb = 'https://huggingface.co/csukuangfj2/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11/resolve/ab43d895f5985b1bbab8b6eac8607fcdc05343f3'
  foreach ($f in @(
      @('encoder.int8.onnx', '012E9321373AF99021415E0B0EB3EC827B4BE3153BE6F30D9B448FE65E896E68'),
      @('decoder.int8.onnx', '19F9C98FC6D0A2C33A65A43B36FDB2E914C26C0AA9764BE3AEBC502A1E982FB0'),
      @('joiner.int8.onnx', '4101C7C679A0BC30483794B27A059E34E79232AA2068D78D51231A22C8B0D7CE'),
      @('tokens.txt', '729CC103155BAFA785F9CD45746CD41CABE97EAB7182FC04D594129587958F8A'))) {
    Get-Pinned "$nb/$($f[0])" "$m\nemotron-560\$($f[0])" $f[1]
  }
  Push-Location $root; node get-models.js @Langs; $code = $LASTEXITCODE; Pop-Location
  if ($code) { throw 'get-models.js failed' }
}

# GPU speech model: fp32 80 ms Nemotron + sherpa-onnx's CUDA build + CUDA 12.8 / cuDNN 9 DLLs (from NVIDIA's pip wheels,
# so no CUDA toolkit install). CUDA 12.2 DLLs fail on onnxruntime 1.28 ("procedure could not be found"); 12.8 works on
# driver 536 (GTX 1060). The int8 models do not speed up on the GPU; the fp32 one does (~40 ms per 80 ms chunk).
if ($Gpu) {
  $nf = 'https://huggingface.co/csukuangfj2/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-80ms-2026-06-11/resolve/88535ae65d52ba59d5234be261df60176ab848a3'
  foreach ($f in @(
      @('encoder.onnx', '7653346424B84EDB6D4C104B50BA1BE7A055DD4BC0EF0277B773C7F822DADD09'),
      @('encoder.data', '7584F85DF76BC9AE6FBDFA53AA8D97B07A842525D1C501D536D77FD9E4F57AC7'),
      @('decoder.onnx', 'F9C59EE6FA130BC2BA349DBCBBA7C74A4A960A98D4196295BA4E8E5D6BDE6B68'),
      @('joiner.onnx', 'A6BD74C0A31CBDE0DA0368C1E29D171752108C7AD1231630E079A7D97CEEE6F0'),
      @('tokens.txt', '729CC103155BAFA785F9CD45746CD41CABE97EAB7182FC04D594129587958F8A'))) {
    Get-Pinned "$nf/$($f[0])" "$m\nemotron-80-fp32\$($f[0])" $f[1]
  }
  $cu = Join-Path $root 'vendor\sherpa-cuda'
  if (-not (Test-Path "$cu\onnxruntime_providers_cuda.dll")) {
    $gitUsr = Join-Path $env:ProgramFiles 'Git\usr\bin'
    $tmp = Join-Path $root 'vendor\sherpa-cuda-tmp'
    $name = 'sherpa-onnx-v2.0.1-cuda-12.x-cudnn-9.x-onnxruntime1.28.2-win-x64-cuda'
    Get-Pinned "https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/$name.tar.bz2" "$tmp\s.tar.bz2" 'CD983FA95431A8A08555B15005E1EFFD0B771F161D30F7F3BD52D518DA48F6B6'
    $oldPath = $env:PATH; $env:PATH = "$gitUsr;$env:PATH"
    Push-Location $tmp; try { & "$gitUsr\tar.exe" -xjf s.tar.bz2 "$name/lib" } finally { Pop-Location; $env:PATH = $oldPath }
    if ($LASTEXITCODE) { throw 'tar failed on the sherpa-onnx CUDA archive' }
    New-Item -ItemType Directory -Force $cu | Out-Null
    Move-Item "$tmp\$name\lib\*.dll" $cu -Force
    Copy-Item (Join-Path $root 'node_modules\sherpa-onnx-win-x64\sherpa-onnx.node') $cu  # same addon, loads the CUDA onnxruntime next to it
    Remove-Item -Recurse -Force $tmp
  }
  $whl = 'https://files.pythonhosted.org/packages'
  foreach ($w in @(
      @("$whl/30/a5/a515b7600ad361ea14bfa13fb4d6687abf500adc270f19e89849c0590492/nvidia_cuda_runtime_cu12-12.8.90-py3-none-win_amd64.whl", 'C0C6027F01505BFED6C3B21EC546F69C687689AAD5F1A377554BC6CA4AA993A8', 'cudart64_12.dll'),
      @("$whl/70/61/7d7b3c70186fb651d0fbd35b01dbfc8e755f69fd58f817f3d0f642df20c3/nvidia_cublas_cu12-12.8.4.1-py3-none-win_amd64.whl", '47E9B82132FA8D2B4944E708049229601448AAAD7E6F296F630F2D1A32DE35AF', 'cublas64_12.dll'),
      @("$whl/7d/ec/ce1629f1e478bb5ccd208986b5f9e0316a78538dd6ab1d0484f012f8e2a1/nvidia_cufft_cu12-11.3.3.83-py3-none-win_amd64.whl", '7A64A98EF2A7C47F905AAF8931B69A3A43F27C55530C698BB2ED7C75C0B42CB7', 'cufft64_11.dll'),
      @("$whl/db/67/cf2f75cfa730a78a8ea0fcfb48c776e1a8c1aeef235c91826ac85e05923c/nvidia_cudnn_cu12-9.0.0.312-py3-none-win_amd64.whl", '52043EE7507DFCC1EFF4D2C5C208B8B6531D71B224BC586AEC5C92075B677563', 'cudnn64_9.dll'))) {
    if (Test-Path "$cu\$($w[2])") { continue }
    $z = Join-Path $root "vendor\$(Split-Path $w[0] -Leaf).zip"  # a .whl is a zip
    Get-Pinned $w[0] $z $w[1]
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($z)
    try { foreach ($e in $zip.Entries | Where-Object { $_.FullName -match '^nvidia/[^/]+/bin/[^/]+\.dll$' }) { [IO.Compression.ZipFileExtensions]::ExtractToFile($e, "$cu\$($e.Name)", $true) } }
    finally { $zip.Dispose() }
    Remove-Item $z
  }
}
Write-Host "OK. whisper: $whisperDir\Release  llama: $(Resolve-Path $bench)"
