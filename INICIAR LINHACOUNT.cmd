@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Execute primeiro INSTALAR IA.cmd
  pause
  exit /b 1
)
".venv\Scripts\python.exe" backend\start_local.py
if errorlevel 1 pause

