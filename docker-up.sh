#!/usr/bin/env bash
# macOS / Linux: native llama-server (Hy-MT2 on the GPU: Metal on a Mac) on 0.0.0.0:8099 + the Docker stack using it,
# then opens the app. Docker on a Mac cannot reach the GPU, so Hy-MT2 must run outside the container to be fast.
# Usage: ./docker-up.sh          start (or reuse) everything and open http://localhost:3000
#        ./docker-up.sh tunnel   also a Cloudflare tunnel to the Elixir server, so room listeners can join from the internet
#                                (needs APP_TOKEN; TUNNEL_TOKEN = your named tunnel, else a quick trycloudflare.com URL)
#        ./docker-up.sh down     stop the containers and the llama-server this script started
# Needs: Docker Desktop (or OrbStack / Colima), curl, tar. Downloads llama.cpp + Hy-MT2 on first run (sha256-checked).
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$PWD D=$ROOT/data V=$ROOT/vendor M=$ROOT/models
mkdir -p "$D"
F=(-f docker-compose.yml -f docker-compose.host-llm.yml)
[ "${1:-}" = down ] && F+=(-f docker-compose.tunnel.yml --profile quick --profile named) && export APP_TOKEN=${APP_TOKEN:-down} # stop the tunnel too
[ "${1:-}" = tunnel ] && F+=(-f docker-compose.tunnel.yml --profile "$([ -n "${TUNNEL_TOKEN:-}" ] && echo named || echo quick)")
compose() { docker compose "${F[@]}" "$@"; }
up() { curl -fs -m 2 "$1" >/dev/null 2>&1; }

if [ "${1:-}" = down ]; then
  compose down --remove-orphans
  [ -f "$D/host-llama.pid" ] && kill "$(cat "$D/host-llama.pid")" 2>/dev/null || true
  rm -f "$D/host-llama.pid"; echo stopped; exit 0
fi
command -v docker >/dev/null || { echo "missing: docker (Docker Desktop, OrbStack or Colima)" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running: start Docker Desktop first" >&2; exit 1; }

sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
get() { # URL OUT SHA256
  [ -f "$2" ] && [ "$(sha "$2")" = "$3" ] && return
  mkdir -p "$(dirname "$2")"; echo "Downloading $(basename "$2")..."
  curl -fL --retry 3 -o "$2.part" "$1"
  [ "$(sha "$2.part")" = "$3" ] || { rm -f "$2.part"; echo "sha256 mismatch for $2" >&2; exit 1; }
  mv "$2.part" "$2"
}

if ! up http://127.0.0.1:8099/health; then
  # same llama.cpp build and Hy-MT2 file as setup.sh (b12428; Metal on Apple Silicon)
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)  b=macos-arm64;  s=7d72477a2a375cc1d93e308b34e26fb9a608c2f93750517d2bafc59af578d3e2 ;;
    Darwin-x86_64) b=macos-x64;    s=27e4277bdbabcc9a4925cac77d99cd792abe0600c71bc33f265c43b8ea379d87 ;;
    Linux-x86_64)  b=${LLAMA_BUILD:-ubuntu-x64}; s=a9b243a3bc4ca172010e96c64062fc02afd1dc4f8b699716f813ae6845ada4c6
                   [ "$b" = ubuntu-vulkan-x64 ] && s=7694190faaaef1d66c692c21f43fd4305374d7a8156274e6a1a7ee7637d3efdc ;;
    Linux-aarch64) b=ubuntu-arm64; s=68fdee3e3086de8d1b6b3ef3bb791ff03ec4a6f2a8e7e199130fb70167d33d6d ;;
    *) echo "no llama.cpp build for $(uname -sm)" >&2; exit 1 ;;
  esac
  if [ ! -x "$V/llama/llama-server" ] || [ "$(cat "$V/llama/.build" 2>/dev/null)" != "$b" ]; then
    get "https://github.com/ggml-org/llama.cpp/releases/download/b12428/llama-b12428-bin-$b.tar.gz" "$V/llama.tgz" "$s"
    rm -rf "$V/llama"; mkdir -p "$V/llama"
    tar -xzf "$V/llama.tgz" -C "$V/llama" --strip-components=1
    rm "$V/llama.tgz"; echo "$b" > "$V/llama/.build"
    [ "$(uname -s)" = Darwin ] && xattr -dr com.apple.quarantine "$V/llama" 2>/dev/null || true # unsigned binaries
  fi
  get https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/resolve/a0c709d9fac510f2c807aa3af52872340dc37a4a/Hy-MT2-1.8B-Q4_K_M.gguf \
    "$M/Hy-MT2-Q4.gguf" dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699
  # 0.0.0.0 so containers reach it via host.docker.internal; macOS may ask once to allow incoming connections
  nohup "$V/llama/llama-server" -m "$M/Hy-MT2-Q4.gguf" --host 0.0.0.0 --port 8099 -ngl 99 --jinja -c 2048 >"$D/host-llama.log" 2>&1 &
  echo $! >"$D/host-llama.pid"
  for _ in $(seq 180); do up http://127.0.0.1:8099/health && break
    kill -0 "$(cat "$D/host-llama.pid")" 2>/dev/null || { echo "llama-server exited; see $D/host-llama.log" >&2; exit 1; }; sleep 0.5; done
  up http://127.0.0.1:8099/health || { echo "llama-server not ready after 90 s; see $D/host-llama.log" >&2; exit 1; }
  echo "llama-server on the GPU: http://127.0.0.1:8099 (pid $(cat "$D/host-llama.pid"))"
else echo "reusing the llama-server already on :8099"; fi

compose up -d --build --remove-orphans
for _ in $(seq 180); do up http://127.0.0.1:3000/api/languages && break; sleep 1; done
up http://127.0.0.1:3000/api/languages || { echo "app not ready after 180 s; see: docker compose logs node" >&2; exit 1; }
echo "ready: http://localhost:3000 (Node)  http://localhost:3001 (Elixir)"
if [ "${1:-}" = tunnel ] && [ -z "${TUNNEL_TOKEN:-}" ]; then
  u=; for _ in $(seq 60); do u=$(compose logs quick 2>&1 | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1); [ -n "$u" ] && break; sleep 1; done
  [ -n "$u" ] || { echo "no tunnel URL after 60 s; see: docker compose logs quick" >&2; exit 1; }
  echo "public: speaker $u/?room=<name>&token=<APP_TOKEN>   listeners $u/r/<name>"
elif [ "${1:-}" = tunnel ]; then echo "public: the hostname you set on the named tunnel (Cloudflare Zero Trust > Networks > Tunnels)"; fi
if command -v open >/dev/null; then open http://localhost:3000; elif command -v xdg-open >/dev/null; then xdg-open http://localhost:3000 >/dev/null 2>&1 || true; fi
