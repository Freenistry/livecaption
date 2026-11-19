#!/usr/bin/env bash
# macOS / Linux: runs llama-server (Hy-MT2, :8099) and the Elixir server (:3000) in the background. Run ./setup.sh first.
# Usage: ./serve.sh            start, returns when the app answers on http://localhost:3000/
#        ./serve.sh status     running?
#        ./serve.sh stop       stop both
#        ./serve.sh fg         run in the foreground (Ctrl+C stops both)
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$PWD D=$ROOT/data PORT=${PORT:-3000}
mkdir -p "$D"
alive() { [ -f "$D/$1.pid" ] && kill -0 "$(cat "$D/$1.pid")" 2>/dev/null; }
stop() { for p in app llama; do alive $p && kill "$(cat "$D/$p.pid")" 2>/dev/null; rm -f "$D/$p.pid"; done; }
wait_for() { # url seconds name
  for _ in $(seq $(($2 * 2))); do curl -fs "$1" >/dev/null 2>&1 && return; alive "$3" || { echo "$3 exited; see $D/$3.log" >&2; stop; exit 1; }; sleep 0.5; done
  echo "timed out waiting for $1; see $D/$3.log" >&2; stop; exit 1
}

case "${1:-start}" in
  stop) stop; echo stopped; exit 0 ;;
  status) for p in llama app; do alive $p && echo "$p: running (pid $(cat "$D/$p.pid"))" || echo "$p: stopped"; done; exit 0 ;;
  start|fg) ;;
  *) echo "usage: $0 [start|stop|status|fg]" >&2; exit 2 ;;
esac
alive app && { echo "already running: http://localhost:$PORT/"; exit 0; }
[ -x vendor/llama/llama-server ] && [ -f models/Hy-MT2-Q4.gguf ] && [ -d server_ex/_build/prod ] || { echo "run ./setup.sh first" >&2; exit 1; }

# -ngl 99: all layers on the GPU (Metal on Apple Silicon, Vulkan build on Linux); the CPU build ignores it
nohup vendor/llama/llama-server -m models/Hy-MT2-Q4.gguf --host 127.0.0.1 --port 8099 -ngl 99 --jinja -c 2048 >"$D/llama.log" 2>&1 &
echo $! >"$D/llama.pid"
wait_for http://127.0.0.1:8099/health 120 llama

rm -f "$D/app.pid"
export MIX_ENV=prod MT_URL=http://127.0.0.1:8099 PORT PID_FILE="$D/app.pid" # the app writes its own VM pid
if [ "${1:-start}" = fg ]; then
  trap 'stop; exit 0' INT TERM
  (cd server_ex && exec mix run --no-halt) &
  wait $! || true; stop
else
  (cd server_ex && nohup mix run --no-halt >"$D/app.log" 2>&1 &)
  for _ in $(seq 60); do [ -s "$D/app.pid" ] && break; sleep 0.5; done
  wait_for "http://127.0.0.1:$PORT/api/languages" 120 app
  echo "ready: http://localhost:$PORT/   (logs: data/app.log, data/llama.log; ./serve.sh stop)"
fi
