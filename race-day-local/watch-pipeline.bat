@echo off
rem ============================================================================
rem Pipeline watcher window (ownership-aware) - Phase 7A.2b Step 4.
rem
rem Runs the EXISTING pipeline:watch npm script (which claims the producer
rem ownership for the date, heartbeats it, and fails closed on loss). npm's
rem exit code is preserved THROUGH the live Tee-Object logging by running npm
rem inside PowerShell and returning $LASTEXITCODE - a plain cmd pipe would
rem overwrite ERRORLEVEL with the pipe's own status.
rem
rem Exit-code policy (mirrors classifyPipelineWatchExit in
rem src/lib/raceDayLauncher.ts and Step 2's pipeline exit contract):
rem   0 -> graceful stop (until/max-cycles/Ctrl+C). TERMINAL - not restarted.
rem   2 -> claim mechanism unavailable/uncertain. TERMINAL - fail closed;
rem        investigate before any restart.
rem   3 -> ownership REFUSED or LOST. TERMINAL - another producer owns the
rem        date (or took it over); restarting cannot help until the operator
rem        intervenes. Check: npm run producer:claim-check -- --date <date>
rem   86 -> wrapper sentinel: npm.cmd was not found or never started ^(no
rem        native exit code was produced^). TERMINAL configuration failure -
rem        NEVER reported as graceful.
rem   1/other -> generic failure/crash. Bounded retry: at most 5 restarts,
rem        60 seconds apart, then a visible degraded terminal state.
rem
rem The window stays open (cmd /k) in every terminal state. This file never
rem touches the database, providers, or the claim itself - only the npm script.
rem Args: %1 = date  %2 = course  %3 = log dir
rem Launched by start-race-day.bat - not usually run by hand.
rem ============================================================================
setlocal EnableExtensions
chcp 65001 >nul
set "RACE_DATE=%~1"
set "COURSE=%~2"
set "LOGDIR=%~3"
set "LOG=%LOGDIR%\pipeline-watch.log"
set /a RETRIES=0

:loop
echo.
echo [%DATE% %TIME%] pipeline:watch starting (interval 5 min, --commit)...
echo [%DATE% %TIME%] pipeline:watch starting>>"%LOG%"
powershell -NoProfile -Command "try { npm.cmd run pipeline:watch -- --date %RACE_DATE% --course \"%COURSE%\" --interval-minutes 5 --commit 2>&1 | Tee-Object -FilePath '%LOG%' -Append } catch { Write-Host ('wrapper: npm.cmd invocation failed - ' + $_.Exception.Message) }; $code = $LASTEXITCODE; if ($null -eq $code) { Write-Host 'wrapper: npm.cmd did not run (no native exit code) - reporting wrapper failure 86'; exit 86 }; exit $code"
set "CODE=%ERRORLEVEL%"
>>"%LOG%" echo [%DATE% %TIME%] pipeline:watch exited with code %CODE%

if "%CODE%"=="0" (
  echo.
  echo [%DATE% %TIME%] pipeline:watch stopped GRACEFULLY ^(exit 0^).
  echo   Not restarting - this was a deliberate stop ^(until/max-cycles/Ctrl+C^).
  goto terminal
)
if "%CODE%"=="3" (
  echo.
  echo [%DATE% %TIME%] TERMINAL: producer OWNERSHIP refused or lost ^(exit 3^).
  echo   Another producer holds this date, or took the claim over. Restarting
  echo   cannot help until that changes. NOT restarting automatically.
  echo   Inspect: npm run producer:claim-check -- --date %RACE_DATE%
  goto terminal
)
if "%CODE%"=="2" (
  echo.
  echo [%DATE% %TIME%] TERMINAL: claim mechanism unavailable/uncertain ^(exit 2^).
  echo   Fail-closed: no provider/model work ran after the failure. Investigate
  echo   Supabase reachability before any restart. NOT restarting automatically.
  goto terminal
)

if "%CODE%"=="86" (
  echo.
  echo [%DATE% %TIME%] TERMINAL: npm.cmd could not be executed ^(wrapper code 86^).
  echo   Configuration failure - npm.cmd was not found or never started, so NO
  echo   pipeline work ran. Check the Node.js/npm installation and PATH, then
  echo   re-run the launcher. NOT retrying automatically.
  goto terminal
)

set /a RETRIES+=1
if %RETRIES% GTR 5 (
  echo.
  echo [%DATE% %TIME%] TERMINAL: pipeline:watch failed %RETRIES% times ^(last exit %CODE%^).
  echo   Maximum of 5 bounded retries reached - staying DEGRADED, not looping.
  echo   See %LOG% then re-run the launcher when the cause is fixed.
  echo [%DATE% %TIME%] degraded terminal after max retries>>"%LOG%"
  goto terminal
)
echo.
echo [%DATE% %TIME%] [WARN] pipeline:watch exit %CODE% - bounded retry %RETRIES%/5 in 60 seconds.
echo [%DATE% %TIME%] bounded retry %RETRIES%/5 scheduled>>"%LOG%"
timeout /t 60 /nobreak >nul
goto loop

:terminal
echo.
echo This window stays open so the state above remains visible. Close it (or
echo Ctrl+C) when you have read it. The lock and results watchers run
echo independently and are NOT affected by this window.
endlocal
