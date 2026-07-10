@echo off
rem ============================================================================
rem Local race-day supervisor launcher (Windows).
rem
rem One command before leaving: runs the initial pipeline load, then opens
rem THREE visible watcher windows (pipeline / T-minus locks / results). All
rem work goes through the EXISTING safe npm scripts only — this file adds no
rem new database access, no betting, no model/staking/confidence changes.
rem
rem Usage (defaults: date 2026-07-11, course Newmarket):
rem   race-day-local\start-race-day.bat
rem   race-day-local\start-race-day.bat 2026-07-12 "Newmarket"
rem
rem Runbook: docs\LOCAL_RACE_DAY_SUPERVISOR.md
rem ============================================================================
setlocal

set "RACE_DATE=%~1"
if "%RACE_DATE%"=="" set "RACE_DATE=2026-07-11"
set "COURSE=%~2"
if "%COURSE%"=="" set "COURSE=Newmarket"

set "REPO=%~dp0.."
pushd "%REPO%"

rem Course slug for the log folder (lower-case, non-alphanumerics -> "-").
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "('%COURSE%').ToLower() -replace '[^a-z0-9]+','-' -replace '^-+|-+$',''"`) do set "SLUG=%%i"
set "LOGDIR=%CD%\logs\race-day-%RACE_DATE%-%SLUG%"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

echo ============================================================
echo  RACE DAY SUPERVISOR  -  %RACE_DATE%  %COURSE%
echo  Logs: %LOGDIR%
echo  Decision-support only - no betting, no bet placement.
echo ============================================================
echo.
echo [1/4] Initial pipeline load (pipeline:day --commit)...
echo       This can take a few minutes; full output goes to pipeline-day.log.
call npm run pipeline:day -- --date %RACE_DATE% --course "%COURSE%" --commit >>"%LOGDIR%\pipeline-day.log" 2>&1
if errorlevel 1 (
  echo [WARN] initial pipeline:day reported a failure - the pipeline watcher
  echo        will retry on its normal cycle; check %LOGDIR%\pipeline-day.log
) else (
  echo       initial load finished cleanly.
)
echo --- last lines of pipeline-day.log ---
powershell -NoProfile -Command "Get-Content -Tail 15 '%LOGDIR%\pipeline-day.log'"
echo ---------------------------------------

echo.
echo [2/4] Starting PIPELINE watcher window...
start "PIPELINE WATCH %RACE_DATE% %COURSE%" /d "%CD%" cmd /k ""%~dp0watch-pipeline.bat" %RACE_DATE% "%COURSE%" "%LOGDIR%""

echo [3/4] Starting T-MINUS LOCK watcher window...
start "LOCK WATCH %RACE_DATE% %COURSE%" /d "%CD%" cmd /k ""%~dp0watch-locks.bat" %RACE_DATE% "%COURSE%" "%LOGDIR%""

echo [4/4] Starting RESULTS watcher window...
start "RESULTS WATCH %RACE_DATE% %COURSE%" /d "%CD%" cmd /k ""%~dp0watch-results.bat" %RACE_DATE% "%COURSE%" "%LOGDIR%""

echo.
echo All three watcher windows are up. Keep them OPEN all day.
echo Phone dashboard: https://ascott-race-bot-production.up.railway.app/?day=today^&course=%COURSE%
echo To stop everything: close the three watcher windows (or Ctrl+C in each).
echo Runbook: docs\LOCAL_RACE_DAY_SUPERVISOR.md
popd
endlocal
