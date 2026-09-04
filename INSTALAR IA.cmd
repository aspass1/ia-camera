@echo off
setlocal
cd /d "%~dp0"
py -3.11 -m venv .venv
if errorlevel 1 goto :erro
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements-ai.txt
if errorlevel 1 goto :erro
echo.
echo Instalacao concluida.
pause
exit /b 0
:erro
echo.
echo A instalacao falhou. Confirme que o Python 3.11 esta instalado.
pause
exit /b 1

