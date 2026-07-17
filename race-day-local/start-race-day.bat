@echo off
rem ============================================================================
rem Ownership-aware local race-day supervisor launcher (Windows).
rem Phase 7A.2b Step 4 - configurable, preflight-gated, no hardcoded meeting.
rem
rem Usage (date and course are REQUIRED - there are no defaults):
rem   race-day-local\start-race-day.bat YYYY-MM-DD "Course Name"
rem   race-day-local\start-race-day.bat YYYY-MM-DD "Course Name" --preflight-only
rem
rem What it does, in order:
rem   1. Validates date/course via the read-only race-day:launch-check helper
rem      (strict date, Windows-safe selected course, reserved nationwide input
rem      rejected, scoped dashboard URLs built with encoding).
rem   2. Atomically acquires the LOCAL launcher lock (a lock DIRECTORY under
rem      the log folder) BEFORE preflight and before any pipeline/watcher. A
rem      second launcher for the same date/course fails clearly and starts
rem      NOTHING. The lock is never deleted automatically when found.
rem   3. Runs producer:preflight --require-server (no --confirm-external).
rem      BLOCKED/usage -> start nothing, clean the just-created lock (no
rem      children were started), exit non-zero. REVIEW -> requires the operator
rem      to type CONTINUE exactly, then reruns preflight WITH
rem      --confirm-external; only READY continues.
rem   4. --preflight-only: prints the launch plan + URLs, removes its own lock,
rem      exits without starting anything (Gate C mode).
rem   5. Normal mode: initial pipeline:day --commit (ownership-aware). If it
rem      fails: NO watcher windows, lock cleaned (no children), exit non-zero.
rem   6. Launches the three watcher windows (pipeline / T-minus locks /
rem      results) with the validated date/course, prints the scoped local and
rem      (if configured via PUBLIC_DASHBOARD_URL) public dashboard URLs.
rem   7. Cleanup: only typing STOPPED exactly - after all three watcher windows
rem      are closed - removes the local lock. Anything else keeps it and prints
rem      recovery guidance. Closing this window leaves the lock in place; it
rem      never releases the DATABASE producer claim (the pipeline watcher owns
rem      that; a crashed claim TTL-expires on its own).
rem
rem All work goes through the EXISTING safe npm scripts. This file performs no
rem database access, no provider/model calls, no betting, no bet placement.
rem The database producer claim remains the authoritative cross-machine guard;
rem the local lock only prevents duplicate three-window launchers on this
rem machine. Runbook: docs\LOCAL_RACE_DAY_SUPERVISOR.md
rem ============================================================================
setlocal EnableExtensions EnableDelayedExpansion

set "RACE_DATE=%~1"
set "COURSE=%~2"
set "MODE=%~3"

if "%RACE_DATE%"=="" goto usage
if "%COURSE%"=="" goto usage
set "PREFLIGHT_ONLY=0"
if /i "%MODE%"=="--preflight-only" set "PREFLIGHT_ONLY=1"

set "REPO=%~dp0.."
pushd "%REPO%"

rem --- [1/6] Validate date/course + build URLs (read-only TypeScript helper) --
set "LCOUT=%TEMP%\race-day-launch-check.out"
set "LCERR=%TEMP%\race-day-launch-check.err"
call npm run --silent race-day:launch-check -- --date %RACE_DATE% --course "%COURSE%" >"%LCOUT%" 2>"%LCERR%"
if errorlevel 1 (
  echo.
  echo [BLOCKED] Invalid launcher input - nothing was started:
  type "%LCERR%"
  popd
  exit /b 1
)
set "SLUG="
set "LOCAL_URL="
set "PROD_URL="
for /f "usebackq tokens=1,* delims==" %%A in ("%LCOUT%") do set "%%A=%%B"
if "%SLUG%"=="" (
  echo [BLOCKED] launch-check produced no slug - refusing to continue.
  popd
  exit /b 1
)

set "LOGDIR=%CD%\logs\race-day-%RACE_DATE%-%SLUG%"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "SUPLOG=%LOGDIR%\supervisor.log"
>>"%SUPLOG%" echo [%DATE% %TIME%] launcher start date=%RACE_DATE% course=!COURSE! preflight_only=%PREFLIGHT_ONLY%

echo ============================================================
echo  RACE DAY SUPERVISOR  -  %RACE_DATE%  !COURSE!
echo  Logs: %LOGDIR%
echo  Decision-support only - no betting, no bet placement.
echo ============================================================

rem --- [2/6] ATOMIC local launcher lock (BEFORE preflight / pipeline / watchers)
rem mkdir on an existing directory fails, and directory creation is atomic, so
rem the first launcher wins and a second launcher for the same date/course is
rem refused here having started NOTHING.
set "LOCKDIR=%LOGDIR%\supervisor.lock"
mkdir "%LOCKDIR%" 2>nul
if errorlevel 1 (
  echo.
  echo [BLOCKED] A local supervisor lock already exists for this date/course:
  echo           %LOCKDIR%
  echo.
  echo   Another launcher may already be running on this machine. NOTHING was
  echo   started by this attempt - no preflight, no pipeline, no watchers.
  echo.
  echo   Manual recovery ^(this launcher NEVER deletes the lock automatically^):
  echo     1. Check for open PIPELINE/LOCK/RESULTS watcher windows for
  echo        %RACE_DATE% !COURSE! and use them if they are healthy.
  echo     2. Only if you are certain no supervisor is running ^(e.g. after a
  echo        crash or reboot^), delete the folder above yourself and re-run.
  echo     3. Deleting the local lock never touches the DATABASE producer
  echo        claim - a crashed pipeline watcher's claim TTL-expires on its own.
  echo [%DATE% %TIME%] local lock REFUSED - already exists>>"%SUPLOG%"
  popd
  exit /b 1
)
>"%LOCKDIR%\metadata.txt" echo date=%RACE_DATE%
>>"%LOCKDIR%\metadata.txt" echo course=!COURSE!
>>"%LOCKDIR%\metadata.txt" echo slug=%SLUG%
>>"%LOCKDIR%\metadata.txt" echo created_at=%DATE% %TIME%
echo [%DATE% %TIME%] local lock acquired at %LOCKDIR%>>"%SUPLOG%"

rem --- [3/6] Producer Readiness Preflight gate ---------------------------------
rem First run WITHOUT --confirm-external (the launcher NEVER fakes operator
rem attestation). Exit codes: 0 READY, 3 REVIEW, 2 BLOCKED, 1 usage.
echo.
echo [preflight] running producer:preflight --require-server ...
call npm run producer:preflight -- --date %RACE_DATE% --course "%COURSE%" --require-server >>"%LOGDIR%\preflight.log" 2>&1
set "PF=%ERRORLEVEL%"
>>"%SUPLOG%" echo [%DATE% %TIME%] preflight run 1 exit=%PF%
echo --- preflight output (tail) ---
powershell -NoProfile -Command "Get-Content -Tail 30 '%LOGDIR%\preflight.log'"
echo -------------------------------

if "%PF%"=="0" goto preflight_ready
if "%PF%"=="3" goto preflight_review

rem BLOCKED (2) or usage (1): start nothing. The local lock is removed because
rem NO child process was started (documented no-children cleanup rule).
echo.
echo [BLOCKED] Preflight verdict does not permit a launch (exit %PF%).
echo           Nothing was started. See %LOGDIR%\preflight.log
echo [%DATE% %TIME%] preflight blocked exit=%PF% - lock cleaned (no children started)>>"%SUPLOG%"
rd /s /q "%LOCKDIR%"
popd
exit /b %PF%

:preflight_review
echo.
echo [REVIEW] Preflight passed its automatic checks, but these remain MANUAL:
echo   - Railway job state (cannot be proven from this repository)
echo   - Vercel cron/deployment state (cannot be proven from this repository)
echo   - legacy/unclaimed local producers on this or another machine
echo.
echo   Typing CONTINUE below is an OPERATOR ATTESTATION that you have completed
echo   these checks yourself. It is recorded as your attestation - this
echo   launcher does not and cannot verify them automatically.
echo.
set "ACK="
set /p ACK="Type CONTINUE to attest, anything else aborts: "
if not "%ACK%"=="CONTINUE" (
  echo.
  echo Aborted - nothing was started. Lock cleaned ^(no children started^).
  echo [%DATE% %TIME%] REVIEW acknowledgement declined - aborted>>"%SUPLOG%"
  rd /s /q "%LOCKDIR%"
  popd
  exit /b 3
)
echo [%DATE% %TIME%] operator typed CONTINUE (attestation of manual external checks)>>"%SUPLOG%"
echo.
echo [preflight] re-running WITH --confirm-external --require-server ...
call npm run producer:preflight -- --date %RACE_DATE% --course "%COURSE%" --confirm-external --require-server >>"%LOGDIR%\preflight.log" 2>&1
set "PF2=%ERRORLEVEL%"
>>"%SUPLOG%" echo [%DATE% %TIME%] preflight run 2 (confirm-external) exit=%PF2%
echo --- preflight output (tail) ---
powershell -NoProfile -Command "Get-Content -Tail 30 '%LOGDIR%\preflight.log'"
echo -------------------------------
if not "%PF2%"=="0" (
  echo.
  echo [BLOCKED] Second preflight did not return READY ^(exit %PF2%^).
  echo           Nothing was started. Lock cleaned ^(no children started^).
  echo [%DATE% %TIME%] preflight run 2 not READY - lock cleaned>>"%SUPLOG%"
  rd /s /q "%LOCKDIR%"
  popd
  exit /b %PF2%
)

:preflight_ready
echo.
echo [preflight] READY.

if "%PREFLIGHT_ONLY%"=="1" (
  echo.
  echo === PREFLIGHT-ONLY MODE - launch plan ^(nothing will be started^) ===
  echo   Planned watcher commands:
  echo     npm run pipeline:watch -- --date %RACE_DATE% --course "!COURSE!" --interval-minutes 5 --commit
  echo     npm run lock:t-minus -- --date %RACE_DATE% --course "!COURSE!" --minutes-before 5 --commit
  echo     npm run results:auto -- --date %RACE_DATE% --course "!COURSE!"  ^(dry-run first, then --commit if clean^)
  echo   Local dashboard:      !LOCAL_URL!
  if "!PROD_URL!"=="not-configured" (
    echo   Production dashboard: not configured
  ) else (
    echo   Production dashboard: !PROD_URL!
  )
  echo.
  echo Preflight-only complete. No pipeline, no watchers, no writes were started.
  echo [%DATE% %TIME%] preflight-only complete - lock removed before exit>>"%SUPLOG%"
  rd /s /q "%LOCKDIR%"
  popd
  exit /b 0
)

rem --- [4/6] Initial ownership-aware pipeline load -----------------------------
echo.
echo [pipeline] initial pipeline:day --commit ^(this can take a few minutes^)...
call npm run pipeline:day -- --date %RACE_DATE% --course "%COURSE%" --commit >>"%LOGDIR%\pipeline-day.log" 2>&1
set "PD=%ERRORLEVEL%"
>>"%SUPLOG%" echo [%DATE% %TIME%] initial pipeline:day exit=%PD%
echo --- pipeline-day output (tail) ---
powershell -NoProfile -Command "Get-Content -Tail 15 '%LOGDIR%\pipeline-day.log'"
echo ----------------------------------
if not "%PD%"=="0" (
  echo.
  echo [BLOCKED] Initial pipeline:day failed ^(exit %PD%^).
  echo           NO watcher windows were launched. Lock cleaned ^(no children^).
  echo           Investigate %LOGDIR%\pipeline-day.log then re-run the launcher.
  echo [%DATE% %TIME%] initial pipeline failed exit=%PD% - no watchers - lock cleaned>>"%SUPLOG%"
  rd /s /q "%LOCKDIR%"
  popd
  exit /b %PD%
)

rem --- [5/6] Launch the three watcher windows ----------------------------------
echo.
echo [watchers] starting PIPELINE watcher window...
start "PIPELINE WATCH %RACE_DATE% %COURSE%" /d "%CD%" cmd /k ""%~dp0watch-pipeline.bat" %RACE_DATE% "%COURSE%" "%LOGDIR%""
echo [%DATE% %TIME%] pipeline watcher window launched>>"%SUPLOG%"
echo [watchers] starting T-MINUS LOCK watcher window...
start "LOCK WATCH %RACE_DATE% %COURSE%" /d "%CD%" cmd /k ""%~dp0watch-locks.bat" %RACE_DATE% "%COURSE%" "%LOGDIR%""
echo [%DATE% %TIME%] lock watcher window launched>>"%SUPLOG%"
echo [watchers] starting RESULTS watcher window...
start "RESULTS WATCH %RACE_DATE% %COURSE%" /d "%CD%" cmd /k ""%~dp0watch-results.bat" %RACE_DATE% "%COURSE%" "%LOGDIR%""
echo [%DATE% %TIME%] results watcher window launched>>"%SUPLOG%"

rem --- [6/6] URLs + explicit STOPPED cleanup -----------------------------------
echo.
echo All three watcher windows are up. Keep them OPEN all day.
echo   Local dashboard:      !LOCAL_URL!
if "!PROD_URL!"=="not-configured" (
  echo   Production dashboard: not configured
) else (
  echo   Production dashboard: !PROD_URL!
)
echo.
echo To stop everything: Ctrl+C in each watcher window ^(or close them^).
echo The pipeline watcher releases the database producer claim on a clean stop;
echo a killed window's claim TTL-expires on its own. This launcher never
echo releases the database claim directly.
echo Runbook: docs\LOCAL_RACE_DAY_SUPERVISOR.md

:stop_prompt
echo.
set "DONE="
set /p DONE="Type STOPPED only after the pipeline, lock and results watcher windows have all been closed: "
if not "%DONE%"=="STOPPED" (
  echo.
  echo Local lock retained at %LOCKDIR%
  echo If the watcher windows are still running, leave the lock in place. If
  echo everything is closed and you want to clean up, type STOPPED at the next
  echo prompt - or verify all three windows are closed and delete the folder
  echo yourself. Never assume the watchers stopped just because this window
  echo closed.
  goto stop_prompt
)
echo [%DATE% %TIME%] operator typed STOPPED - removing local lock>>"%SUPLOG%"
rd /s /q "%LOCKDIR%"
echo Local lock removed. Good night.
popd
endlocal
exit /b 0

:usage
echo Usage: race-day-local\start-race-day.bat YYYY-MM-DD "Course Name" [--preflight-only]
echo.
echo   Date and course are REQUIRED - there are no defaults. The course must be
echo   a single selected course; nationwide operation is not available here.
echo   --preflight-only validates, runs the preflight gate, prints the launch
echo   plan and starts nothing.
exit /b 1
