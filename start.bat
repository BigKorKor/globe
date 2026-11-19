@echo off
cd /d "%~dp0"
set PORT=8765
echo Starting on http://localhost:%PORT%
node server.cjs
