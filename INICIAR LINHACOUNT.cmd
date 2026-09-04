@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Execute primeiro INSTALAR IA.cmd
  pause
  exit /b 1
)
start "LinhaCount servidor" /min ".venv\Scripts\python.exe" -m uvicorn backend.server:app --host 127.0.0.1 --port 8766
timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:8766/"

