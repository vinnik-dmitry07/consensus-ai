@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

set "BACKEND_PORT=8001"
set "FRONTEND_PORT=5173"

echo Starting LLM Council...
echo.

call :free_port %BACKEND_PORT%
call :free_port %FRONTEND_PORT%

echo Starting backend on http://localhost:%BACKEND_PORT%...
if exist "%~dp0.venv\Scripts\python.exe" (
  start "LLM Council Backend" /b "%~dp0.venv\Scripts\python.exe" -m backend.main
) else (
  where uv >nul 2>&1
  if not errorlevel 1 (
    start "LLM Council Backend" /b cmd /c "uv run python -m backend.main"
  ) else (
    start "LLM Council Backend" /b python -m backend.main
  )
)

timeout /t 2 /nobreak >nul

echo Starting frontend on http://localhost:%FRONTEND_PORT%...
start "LLM Council Frontend" /b /d "%~dp0frontend" cmd /c "npm run dev -- --port %FRONTEND_PORT% --strictPort"

echo.
echo LLM Council is running!
echo   Backend:  http://localhost:%BACKEND_PORT%
echo   Frontend: http://localhost:%FRONTEND_PORT%
echo.
echo Press Ctrl+C to stop, then re-run this script if ports stay busy.
echo.

:wait_loop
timeout /t 3600 /nobreak >nul
goto wait_loop

:free_port
set "PORT=%~1"
set "FOUND="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /C:":%PORT% " ^| findstr /C:"LISTENING"') do (
  if not "%%P"=="0" if not "%%P"=="" (
    if not defined FOUND (
      echo Port %PORT% is in use - freeing it...
      set "FOUND=1"
    )
    taskkill /F /PID %%P >nul 2>&1
  )
)
if defined FOUND timeout /t 1 /nobreak >nul
goto :eof
