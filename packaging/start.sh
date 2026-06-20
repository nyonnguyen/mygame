#!/usr/bin/env bash
# RetroWeb launcher (macOS / Linux)
# Double-click in a file manager may open this in an editor instead of running it.
# If so, open a Terminal in this folder and run:  ./start.sh
set -e
cd "$(dirname "$0")"

# macOS: clear the Gatekeeper "downloaded from internet" quarantine flag so the
# unsigned binary is allowed to run. Harmless / no-op on Linux.
xattr -dr com.apple.quarantine . 2>/dev/null || true
chmod +x ./retroweb 2>/dev/null || true

# Self-contained: keep ROMs and saved data next to the app unless overridden.
export ROM_DIR="${ROM_DIR:-$PWD/roms}"
export DATA_DIR="${DATA_DIR:-$PWD/data}"
export PORT="${PORT:-3000}"
mkdir -p "$ROM_DIR" "$DATA_DIR"

URL="http://localhost:$PORT"
echo "================================================================"
echo " RetroWeb is starting at  $URL"
echo " Put your ROMs in:        $ROM_DIR"
echo " (organize by system, e.g. roms/snes/, roms/genesis/ ...)"
echo " Press Ctrl+C to stop."
echo "================================================================"

# Open the browser shortly after the server boots.
(
  sleep 2
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  fi
) >/dev/null 2>&1 &

exec ./retroweb
