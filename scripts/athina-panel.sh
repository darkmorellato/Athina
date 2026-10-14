#!/usr/bin/env bash
# Abre o painel da Athina em uma janela própria (sem barra de endereço).
# Sobe o frontend e o TTS se não estiverem rodando; o backend roda pelo systemd.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/athina"
PROFILE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/athina-panel-profile"
PANEL_URL="http://127.0.0.1:5173"
mkdir -p "$STATE_DIR" "$PROFILE_DIR"

notify() {
  if command -v notify-send >/dev/null 2>&1; then notify-send "Athina" "$1"; fi
  echo "$1" >&2
}

is_up() { curl -s -m 2 -o /dev/null "$1"; }

if ! systemctl is-active --quiet athina-backend; then
  notify "Backend parado. Rode: sudo systemctl start athina-backend"
fi

if ! is_up "$PANEL_URL/"; then
  (cd "$ROOT" && nohup npm run dev:frontend >"$STATE_DIR/frontend.log" 2>&1 &)
fi
if ! is_up "http://127.0.0.1:5050/health"; then
  (cd "$ROOT" && nohup npm run dev:tts >"$STATE_DIR/tts.log" 2>&1 &)
fi

for _ in $(seq 1 60); do
  is_up "$PANEL_URL/" && break
  sleep 1
done

BROWSER=""
for candidate in google-chrome google-chrome-stable chromium chromium-browser brave-browser \
  "$HOME"/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome; do
  if command -v "$candidate" >/dev/null 2>&1; then BROWSER="$(command -v "$candidate")"; break; fi
  if [ -x "$candidate" ]; then BROWSER="$candidate"; break; fi
done

if [ -z "$BROWSER" ]; then
  notify "Nenhum navegador Chrome/Chromium encontrado."
  exit 1
fi

exec "$BROWSER" --app="$PANEL_URL" --user-data-dir="$PROFILE_DIR" --no-first-run --new-window
