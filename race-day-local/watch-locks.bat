@echo off
rem ============================================================================
rem T-minus lock watcher window: every 120 seconds it runs the EXISTING
rem lock:t-minus npm script with --commit. Safety comes from that script, not
rem from this loop: insert-only, commit window enforced (too_early / post-off
rem never persisted), and reruns are idempotent (already_locked). This file
rem never touches the database itself and never modifies a locked decision.
rem
rem Args: %1 = date  %2 = course  %3 = log dir
rem Launched by start-race-day.bat - not usually run by hand.
rem ============================================================================
setlocal
set "RACE_DATE=%~1"
set "COURSE=%~2"
set "LOGDIR=%~3"

:loop
echo.
echo [%date% %time%] lock:t-minus cycle (official T-minus-5, --commit)...
call npm run lock:t-minus -- --date %RACE_DATE% --course "%COURSE%" --minutes-before 5 --commit 2>&1 | powershell -NoProfile -Command "$input | Tee-Object -FilePath '%LOGDIR%\lock-watch.log' -Append"
echo [%date% %time%] cycle done - next check in 120 seconds.
timeout /t 120 /nobreak >nul
goto loop
