#!/usr/bin/env bash
# Deterministic save-mechanism test: serves dist/, drives it in headless Chrome.
# See test/save-check.mjs for why this dispatches events instead of navigating.
#
#   test/run-save-check.sh <rom>
#
# Chrome gets --mute-audio as a second line of defence; the page itself builds
# no AudioContext unless asked, and the harness asserts that.
#
# The debug port is ephemeral (--remote-debugging-port=0, real port read back
# from DevToolsActivePort) and the profile is private. Eighteen agents share
# this box, and a hardcoded port will happily attach to someone else's browser
# and hand back their page -- which has already produced a run on this fleet
# that graded the wrong game. The harness additionally requires the page to echo
# a URL nonce, so attaching to a stranger's tab fails loudly instead of passing.
set -euo pipefail

ROM="${1:?usage: run-save-check.sh <rom>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$HERE/../dist"
TMP="$(mktemp -d)"

# Chrome spawns zygote/gpu/renderer children that outlive a SIGTERM to the
# parent, so it gets its own process group and the whole group is signalled.
# Without this every run leaves a headless browser resident.
kill_group() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
}

cleanup() {
  kill_group "${CHROME_PID:-}"
  kill_group "${HTTP_PID:-}"
  wait 2>/dev/null || true
  rm -rf "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

PORT=$(python3 -c "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()")
# Launched directly, not inside a ( ... ) subshell: backgrounding a subshell
# makes $! the subshell's pid, so the trap would kill the wrapper and leave
# python serving dist/ forever.
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$DIST" >"$TMP/httpd.log" 2>&1 &
HTTP_PID=$!

setsid google-chrome --headless=new --remote-debugging-port=0 --user-data-dir="$TMP/profile" \
  --no-first-run --no-default-browser-check --disable-gpu --mute-audio \
  --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader \
  --window-size=960,720 about:blank >"$TMP/chrome.log" 2>&1 &
CHROME_PID=$!

for _ in $(seq 1 60); do
  [ -s "$TMP/profile/DevToolsActivePort" ] && break
  sleep 0.2
done
CPORT=$(head -1 "$TMP/profile/DevToolsActivePort")

# Close every existing page target first. A leftover tab keeps an IndexedDB
# connection open, which makes deleteDatabase() in the new tab block forever --
# the page then hangs on its first write and never boots the ROM, which looks
# exactly like "the core is broken".
curl -s "http://127.0.0.1:$CPORT/json/list" \
  | python3 -c "import sys,json;[print(t['id']) for t in json.load(sys.stdin) if t['type']=='page']" \
  | while read -r id; do curl -s "http://127.0.0.1:$CPORT/json/close/$id" >/dev/null; done

# /json/new is PUT-only since Chrome 111; a GET gets 405.
WS=$(curl -s -X PUT "http://127.0.0.1:$CPORT/json/new?about:blank" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['webSocketDebuggerUrl'])")

CDP_URL="$WS" node "$HERE/save-check.mjs" "http://127.0.0.1:$PORT/index.html" "$ROM"
