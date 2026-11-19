#!/usr/bin/env bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node 18+ is required (sudo apt install nodejs)"; exit 1; }
PORT="${PORT:-8765}"
echo "Starting on http://localhost:$PORT  (Ctrl+C to stop)"
PORT="$PORT" node server.cjs
