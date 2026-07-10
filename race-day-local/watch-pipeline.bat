@echo off
rem ============================================================================
rem Pipeline watcher window: runs the EXISTING pipeline:watch npm script
rem (which loops internally every --interval-minutes and stops itself at the
rem post-off guard). If the process ever exits (crash, network blip), this
rem window restarts it after 60 seconds instead of dying silently.
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
echo [%date% %time%] pipeline:watch starting (interval 5 min, --commit)...
call npm run pipeline:watch -- --date %RACE_DATE% --course "%COURSE%" --interval-minutes 5 --commit 2>&1 | powershell -NoProfile -Command "$input | Tee-Object -FilePath '%LOGDIR%\pipeline-watch.log' -Append"
echo.
echo [%date% %time%] [WARN] pipeline:watch exited - restarting in 60 seconds.
echo (Ctrl+C now if you are shutting down for the day.)
timeout /t 60 /nobreak >nul
goto loop
