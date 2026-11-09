#!/bin/zsh -l
# Double-click in Finder (or run from a terminal) to start the server and open
# the two screens as full-screen Chrome kiosk windows.
#
#   ./start-kiosk.command          both screens
#   ./start-kiosk.command deaths   only the play + heatmap screen
#   ./start-kiosk.command ai       only the AI screen
#
# The AI window opens at x=1920 (a second monitor to the right of a 1080p
# main display). If your second monitor sits elsewhere, set AI_X / AI_Y,
# e.g.  AI_X=-1920 ./start-kiosk.command  for a monitor on the left.
# Quit a kiosk window with Cmd+Q.

cd "$(dirname "$0")"
PORT=${PORT:-8737}
WHICH=${1:-both}
URL="http://localhost:$PORT"

if ! curl -s "$URL/api/status" >/dev/null 2>&1; then
  mkdir -p data
  echo "Starting server on $URL (log: data/server.log)"
  node server.mjs --port "$PORT" > data/server.log 2>&1 &
  for i in {1..80}; do
    curl -s "$URL/api/status" >/dev/null 2>&1 && break
    sleep 0.25
  done
fi
if ! curl -s "$URL/api/status" >/dev/null 2>&1; then
  echo "The server did not start. See data/server.log."
  exit 1
fi

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
FLAGS=(
  --kiosk
  --autoplay-policy=no-user-gesture-required
  --noerrdialogs
  --disable-session-crashed-bubble
  --disable-infobars
  --no-first-run
  --no-default-browser-check
  --disable-features=Translate
  --overscroll-history-navigation=0
)

# The AI window opens first so the game window ends up with keyboard focus:
# both share one keyboard, and keys only reach the focused window.
if [[ $WHICH == both || $WHICH == ai ]]; then
  "$CHROME" "${FLAGS[@]}" --user-data-dir="$PWD/.chrome/ai" --window-position=${AI_X:-1920},${AI_Y:-0} "$URL/ai.html" >/dev/null 2>&1 &
  [[ $WHICH == both ]] && sleep 3
fi
if [[ $WHICH == both || $WHICH == deaths ]]; then
  "$CHROME" "${FLAGS[@]}" --user-data-dir="$PWD/.chrome/deaths" --window-position=0,0 "$URL/deaths.html" >/dev/null 2>&1 &
fi
echo "Screens open. Setup page: $URL/"
