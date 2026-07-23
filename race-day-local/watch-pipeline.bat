@echo off
rem ============================================================================
rem Pipeline watcher window (ownership-aware) - Phase 7A.2b Step 4 (+ graceful
rem Ctrl+C correction).
rem
rem THIN LAUNCHER: all watcher supervision now lives in the Node helper
rem run-pipeline-watch.js, which spawns `npm.cmd run pipeline:watch` non-detached
rem in this console, tees output to the console + an append-only UTF-8
rem pipeline-watch.log, waits for the watcher's own graceful SIGINT release, and
rem classifies the real exit code. This removes the old cmd+PowerShell Tee-Object
rem chain that hard-killed the watcher on Ctrl+C before its claim release could
rem run. See docs/LOCAL_RACE_DAY_SUPERVISOR.md.
rem
rem Exit-code policy (owned by the helper; window stays open via cmd /k):
rem   0  graceful stop (Ctrl+C / until / max-cycles) - TERMINAL, not restarted.
rem   2  claim mechanism unavailable/uncertain        - TERMINAL, fail-closed.
rem   3  ownership refused or lost                     - TERMINAL.
rem   86 wrapper configuration failure (npm.cmd/log dir/args) - TERMINAL.
rem   other non-zero (genuine crash, no Ctrl+C) - bounded retry <=5 at 60s.
rem
rem This file performs NO database/provider/model/claim work - only the helper's
rem `npm run pipeline:watch`. Never invokes npm.ps1; no execution-policy change.
rem Args: %1 = date  %2 = course  %3 = log dir.  Launched by start-race-day.bat.
rem ============================================================================
setlocal EnableExtensions
chcp 65001 >nul
set "RACE_DATE=%~1"
set "COURSE=%~2"
set "LOGDIR=%~3"

if "%RACE_DATE%"=="" goto usage
if "%COURSE%"=="" goto usage
if "%LOGDIR%"=="" goto usage

rem Run the helper with plain node (fewest console-attached intermediaries, so
rem Ctrl+C reaches the watcher directly and its finally-release completes).
node "%~dp0run-pipeline-watch.js" "%RACE_DATE%" "%COURSE%" "%LOGDIR%"
set "CODE=%ERRORLEVEL%"

echo.
echo [%DATE% %TIME%] watcher helper exited with code %CODE% - see the messages
echo above. This window stays open so the state remains visible; close it (or
echo Ctrl+C) when you have read it. Lock and results watchers are independent
echo and NOT affected by this window.
exit /b %CODE%

:usage
echo Usage: watch-pipeline.bat YYYY-MM-DD "Course Name" "LogDir"
echo   (normally launched by start-race-day.bat, not by hand.)
exit /b 1
