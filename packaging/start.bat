@echo off
REM RetroWeb launcher (Windows) - double-click to run.
cd /d "%~dp0"

if "%ROM_DIR%"=="" set "ROM_DIR=%CD%\roms"
if "%DATA_DIR%"=="" set "DATA_DIR=%CD%\data"
if "%PORT%"=="" set "PORT=3000"
if not exist "%ROM_DIR%" mkdir "%ROM_DIR%"
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"

echo ================================================================
echo  RetroWeb is starting at  http://localhost:%PORT%
echo  Put your ROMs in:        %ROM_DIR%
echo  (organize by system, e.g. roms\snes\, roms\genesis\ ...)
echo  Close this window to stop.
echo ================================================================

start "" "http://localhost:%PORT%"
retroweb.exe
