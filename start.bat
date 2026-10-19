@echo off
setlocal
cd /d "%~dp0"
title EV - Asistente de escritorio

if not exist node_modules (
  echo.
  echo  Instalando dependencias por primera vez...
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo  No se pudieron instalar las dependencias.
    echo  Comprueba que Node.js esta instalado: https://nodejs.org
    echo.
    pause
    exit /b 1
  )
)

node server\index.js

if errorlevel 1 (
  echo.
  echo  EV se detuvo con un error. Revisa el mensaje de arriba.
  pause
)
