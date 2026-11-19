#!/usr/bin/env bash
# macOS / Linux setup for the app (Elixir server + Node engine + llama-server for Hy-MT2). Every download is sha256-pinned.
# Usage: ./setup.sh                    English speech -> the 15 pilot targets
#        MODELS_ONLY=1 ./setup.sh ...  models + Hy-MT2 only (what docker compose's "models" step runs)
#        ./setup.sh es de ja           also these spoken languages (Nemotron CPU model + Bergamot X->en)
# Needs: Elixir >= 1.18, Node >= 20, curl, tar, bzip2. No GPU speech model here (the CUDA build is Windows-only for now).
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$PWD M=$ROOT/models V=$ROOT/vendor

need() { command -v "$1" >/dev/null || { echo "missing: $1 ($2)" >&2; exit 1; }; }
need node "https://nodejs.org, or: brew install node"
[ -n "${MODELS_ONLY:-}" ] || need elixir "brew install elixir | https://elixir-lang.org/install.html (apt's elixir is too old)"
need curl ""; need tar ""; need bzip2 ""
node -e 'process.exit(+process.versions.node.split(".")[0] < 20 ? 1 : 0)' || { echo "need Node >= 20 (have $(node -v))" >&2; exit 1; }
[ -n "${MODELS_ONLY:-}" ] || elixir -e 'System.halt(if Version.match?(System.version(), ">= 1.18.0"), do: 0, else: 1)' || { echo "need Elixir >= 1.18 (built-in JSON)" >&2; exit 1; }

sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
# get URL OUT SHA256: skip if present and correct, else download, check, move into place
get() {
  [ -f "$2" ] && [ "$(sha "$2")" = "$3" ] && return
  mkdir -p "$(dirname "$2")"; echo "Downloading $(basename "$2")..."
  curl -fL --retry 3 -o "$2.part" "$1"
  [ "$(sha "$2.part")" = "$3" ] || { rm -f "$2.part"; echo "sha256 mismatch for $2" >&2; exit 1; }
  mv "$2.part" "$2"
}

# English streaming ASR, final ASR, Bergamot en->zh (same pins as setup.ps1)
hf=https://huggingface.co/csukuangfj/sherpa-onnx-nemo-streaming-fast-conformer-ctc-en-80ms-int8/resolve/2253b9ace8a22074f5e5f0fe9102c248185c34dd
get $hf/model.int8.onnx $M/streaming-ctc/model.int8.onnx bf402c371a293707e90413c5df85484c8bc3aaa7081289c0007aab5ee8ac8e22
get $hf/tokens.txt $M/streaming-ctc/tokens.txt 618dc110fc2213886b52e063ff42329bbdf37a266ca7705184090fa5f39f3131
if [ ! -f $M/parakeet-110m/model.int8.onnx ]; then
  p=sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8
  get https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$p.tar.bz2 $V/p.tar.bz2 17f945007b52ccd8b7200ffc7c5652e9e8e961dfdf479cefcabd06cf5703630b
  mkdir -p $M/parakeet-110m
  tar -xjf $V/p.tar.bz2 -C $V ./$p/model.int8.onnx ./$p/tokens.txt # entries start with ./
  mv $V/$p/model.int8.onnx $V/$p/tokens.txt $M/parakeet-110m/
  rm -rf $V/$p $V/p.tar.bz2
fi
[ "$(sha $M/parakeet-110m/model.int8.onnx)" = 9177a9146cf32ee0cc8152276ef95116f312018d316be37ccf57f7efea81fc1a ] || { echo "sha256 mismatch: parakeet" >&2; exit 1; }

[ -d node_modules/ws ] && [ -d node_modules/sherpa-onnx-node ] && node -e 'require("sherpa-onnx-node")' 2>/dev/null || npm install --no-audit --no-fund
node get-models.js --to=zh-Hans en
for t in hi es ar fr bn pt ru id ur de ja mr vi te; do node get-models.js --to=$t en; done

if [ $# -gt 0 ]; then # other spoken languages: Nemotron 3.5 streaming int8 560 ms (CPU) + Bergamot X->en
  nb=https://huggingface.co/csukuangfj2/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11/resolve/ab43d895f5985b1bbab8b6eac8607fcdc05343f3
  get $nb/encoder.int8.onnx $M/nemotron-560/encoder.int8.onnx 012e9321373af99021415e0b0eb3ec827b4be3153be6f30d9b448fe65e896e68
  get $nb/decoder.int8.onnx $M/nemotron-560/decoder.int8.onnx 19f9c98fc6d0a2c33a65a43b36fdb2e914c26c0aa9764be3aebc502a1e982fb0
  get $nb/joiner.int8.onnx $M/nemotron-560/joiner.int8.onnx 4101c7c679a0bc30483794b27a059e34e79232aa2068d78d51231a22c8b0d7ce
  get $nb/tokens.txt $M/nemotron-560/tokens.txt 729cc103155bafa785f9cd45746cd41cabe97eab7182fc04d594129587958f8a
  node get-models.js "$@"
fi

if [ -z "${MODELS_ONLY:-}" ]; then
# llama.cpp b12428 (Metal on macOS; CPU on Linux, or LLAMA_BUILD=ubuntu-vulkan-x64 for a Vulkan GPU) + Hy-MT2 1.8B Q4
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  b=macos-arm64;  s=7d72477a2a375cc1d93e308b34e26fb9a608c2f93750517d2bafc59af578d3e2 ;;
  Darwin-x86_64) b=macos-x64;    s=27e4277bdbabcc9a4925cac77d99cd792abe0600c71bc33f265c43b8ea379d87 ;;
  Linux-x86_64)  b=ubuntu-x64;   s=a9b243a3bc4ca172010e96c64062fc02afd1dc4f8b699716f813ae6845ada4c6 ;;
  Linux-aarch64) b=ubuntu-arm64; s=68fdee3e3086de8d1b6b3ef3bb791ff03ec4a6f2a8e7e199130fb70167d33d6d ;;
  *) echo "no llama.cpp build for $(uname -sm)" >&2; exit 1 ;;
esac
[ "${LLAMA_BUILD:-}" = ubuntu-vulkan-x64 ] && b=ubuntu-vulkan-x64 s=7694190faaaef1d66c692c21f43fd4305374d7a8156274e6a1a7ee7637d3efdc
if [ ! -x $V/llama/llama-server ] || [ "$(cat $V/llama/.build 2>/dev/null)" != $b ]; then
  get https://github.com/ggml-org/llama.cpp/releases/download/b12428/llama-b12428-bin-$b.tar.gz $V/llama.tgz $s
  rm -rf $V/llama; mkdir -p $V/llama
  tar -xzf $V/llama.tgz -C $V/llama --strip-components=1
  rm $V/llama.tgz
  echo $b > $V/llama/.build
fi
fi
get https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/resolve/a0c709d9fac510f2c807aa3af52872340dc37a4a/Hy-MT2-1.8B-Q4_K_M.gguf \
  $M/Hy-MT2-Q4.gguf dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699

[ -n "${MODELS_ONLY:-}" ] && { echo "OK. models in $M"; exit 0; }
(cd server_ex && mix local.hex --force --if-missing >/dev/null && mix local.rebar --force --if-missing >/dev/null && mix deps.get && MIX_ENV=prod mix compile)
echo "OK. Run ./serve.sh"
