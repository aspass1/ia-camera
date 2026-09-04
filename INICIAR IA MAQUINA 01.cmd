@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Execute primeiro INSTALAR IA.cmd
  pause
  exit /b 1
)
".venv\Scripts\python.exe" backend\live_counter.py --machine 1
pause

