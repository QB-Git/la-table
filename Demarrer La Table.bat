@echo off
cd /d "%~dp0"
setlocal
if not defined PORT if exist ".env" for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do if "%%A"=="PORT" set "PORT=%%B"
if not defined PORT set "PORT=3000"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 ou plus recent est necessaire.
  echo Installe-le depuis https://nodejs.org puis relance ce fichier.
  pause
  exit /b 1
)
start "La Table - serveur" /D "%~dp0" cmd /k node server.js
timeout /t 2 /nobreak >nul
start "" "http://localhost:%PORT%"
