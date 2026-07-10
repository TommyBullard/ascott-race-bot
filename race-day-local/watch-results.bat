@echo off
rem ============================================================================
rem Results watcher window: every 10 minutes it runs the EXISTING results:auto
rem npm script - DRY-RUN FIRST, then --commit ONLY when the dry-run exited
rem cleanly. All matching/settlement semantics and safety gates live inside
rem results:auto itself (same-day sources only, per-race safety gate, loud
rem refusal on blockers, SP/BSP never fabricated); this loop reimplements
rem none of it. A failed cycle is logged and retried next cycle - the loop
rem never dies.
rem
rem Args: %1 = date  %2 = course  %3 = log dir
rem Launched by start-race-day.bat - not usually run by hand.
rem ============================================================================
setlocal
set "RACE_DATE=%~1"
set "COURSE=%~2"
set "LOGDIR=%~3"
set "LOG=%LOGDIR%\results-watch.log"

:loop
echo.
echo [%date% %time%] results:auto DRY-RUN...
echo ================ [%date% %time%] dry-run ================>>"%LOG%"
call npm run results:auto -- --date %RACE_DATE% --course "%COURSE%" >>"%LOG%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] [WARN] dry-run reported a problem - SKIPPING commit this
  echo                 cycle; will retry in 10 minutes. See results-watch.log.
) else (
  echo [%date% %time%] dry-run clean - running results:auto --commit
  echo ================ [%date% %time%] commit =================>>"%LOG%"
  call npm run results:auto -- --date %RACE_DATE% --course "%COURSE%" --commit >>"%LOG%" 2>&1
  if errorlevel 1 (
    echo [%date% %time%] [WARN] commit run reported blockers/failure - nothing
    echo                 forced; the script refuses unless every gate passes.
  ) else (
    echo [%date% %time%] commit cycle finished cleanly.
  )
)
echo --- last lines of results-watch.log ---
powershell -NoProfile -Command "Get-Content -Tail 12 '%LOG%'"
echo ---------------------------------------
echo [%date% %time%] next results check in 10 minutes.
timeout /t 600 /nobreak >nul
goto loop
