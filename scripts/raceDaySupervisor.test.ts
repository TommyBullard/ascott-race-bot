/**
 * Source-scan tests for the ownership-aware configurable local race-day
 * supervisor (race-day-local/*.bat + docs/LOCAL_RACE_DAY_SUPERVISOR.md) —
 * Nationwide rebuild Phase 7A.2b Step 4.
 *
 * The supervisor is Windows batch, so these tests verify its SOURCE (never
 * executing the loops): date/course are REQUIRED with no hardcoded defaults;
 * the ATOMIC local launcher lock (mkdir on a lock DIRECTORY) is acquired
 * BEFORE preflight, the initial pipeline, and every watcher window, is never
 * deleted automatically when already present, and is only removed on the
 * documented no-children-started paths or the exact STOPPED acknowledgement;
 * producer:preflight gates every launch (first WITHOUT --confirm-external;
 * --confirm-external appears only after the exact CONTINUE attestation
 * prompt); --preflight-only starts nothing and cleans its own lock; a failed
 * initial pipeline:day launches zero watcher windows; the pipeline watcher is
 * a THIN launcher that delegates to the Node helper run-pipeline-watch.js
 * (which spawns npm.cmd — never npm.ps1 — non-detached so Ctrl+C reaches the
 * watcher directly, tees to an append-only UTF-8 log, waits for the watcher's
 * own graceful SIGINT release, and applies the 0/2/3/86-terminal + bounded-
 * 5-retry policy); the lock and results watchers keep their existing business
 * rules byte-for-byte; and nothing in any batch/helper file touches the
 * database, providers, betting, or the nationwide scope. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const LAUNCHER = readFileSync('race-day-local/start-race-day.bat', 'utf8');
const PIPELINE = readFileSync('race-day-local/watch-pipeline.bat', 'utf8');
const LOCKS = readFileSync('race-day-local/watch-locks.bat', 'utf8');
const RESULTS = readFileSync('race-day-local/watch-results.bat', 'utf8');
const HELPER = readFileSync('race-day-local/run-pipeline-watch.js', 'utf8');
const RUNBOOK = readFileSync('docs/LOCAL_RACE_DAY_SUPERVISOR.md', 'utf8');
const ALL_BATS = [LAUNCHER, PIPELINE, LOCKS, RESULTS];

/* ------------------------------- launcher: inputs --------------------------- */

test('launcher: date and course are REQUIRED — no hardcoded defaults, usage on missing args', () => {
  assert.match(LAUNCHER, /if "%RACE_DATE%"=="" goto usage/);
  assert.match(LAUNCHER, /if "%COURSE%"=="" goto usage/);
  assert.match(LAUNCHER, /:usage/);
  // No default date/course assignments anywhere.
  assert.equal(/set "RACE_DATE=20\d{2}/.test(LAUNCHER), false, 'no default date');
  assert.equal(/set "COURSE=[A-Za-z]/.test(LAUNCHER), false, 'no default course');
  for (const src of ALL_BATS) {
    assert.equal(/newmarket|curragh|\bascot\b/i.test(src), false, 'no hardcoded course in any bat');
  }
});

// These scans locate actual INVOCATIONS (`call npm run …`), never the header
// comments that legitimately DESCRIBE the workflow in prose.
const PREFLIGHT_CALL = 'call npm run producer:preflight';
const PIPELINE_DAY_CALL = 'call npm run pipeline:day';

test('launcher: validation is delegated to the read-only race-day:launch-check helper before anything else', () => {
  const checkIdx = LAUNCHER.indexOf('call npm run --silent race-day:launch-check');
  const lockIdx = LAUNCHER.indexOf('mkdir "%LOCKDIR%"');
  const preflightIdx = LAUNCHER.indexOf(PREFLIGHT_CALL);
  assert.ok(checkIdx > 0 && lockIdx > 0 && preflightIdx > 0);
  assert.ok(checkIdx < lockIdx, 'launch-check runs before the local lock');
  // Its failure branch stops the launcher (exit /b 1) before the lock exists.
  assert.match(LAUNCHER, /race-day:launch-check[\s\S]{0,400}if errorlevel 1 \(/);
});

/* ---------------------- launcher: atomic local lock ------------------------- */

test('launcher: ATOMIC lock-directory acquired BEFORE preflight, initial pipeline, and every watcher window', () => {
  const lockIdx = LAUNCHER.indexOf('mkdir "%LOCKDIR%"');
  const preflightIdx = LAUNCHER.indexOf(PREFLIGHT_CALL);
  const pipelineDayIdx = LAUNCHER.indexOf(PIPELINE_DAY_CALL);
  const firstStartIdx = LAUNCHER.indexOf('start "PIPELINE WATCH');
  assert.ok(lockIdx > 0);
  assert.ok(preflightIdx > 0 && lockIdx < preflightIdx, 'lock before preflight');
  assert.ok(pipelineDayIdx > 0 && lockIdx < pipelineDayIdx, 'lock before initial pipeline');
  assert.ok(firstStartIdx > 0 && lockIdx < firstStartIdx, 'lock before watcher windows');
  // Atomic-by-design: a bare mkdir (fails if the directory exists) with the
  // refusal branch immediately after — never an "if not exist ... mkdir" race.
  assert.match(LAUNCHER, /mkdir "%LOCKDIR%" 2>nul\s*\r?\nif errorlevel 1 \(/);
  assert.equal(/if not exist "%LOCKDIR%"/.test(LAUNCHER), false, 'no non-atomic exists-then-create sequence');
});

test('launcher: an existing lock refuses with recovery guidance and NEVER deletes it automatically', () => {
  const refusal = LAUNCHER.slice(LAUNCHER.indexOf('if errorlevel 1 ('), LAUNCHER.indexOf('metadata.txt'));
  assert.match(refusal, /NOTHING was/);
  assert.match(refusal, /NEVER deletes the lock automatically/);
  assert.match(refusal, /delete the folder above yourself/);
  assert.match(refusal, /never touches the DATABASE producer/);
  assert.equal(/rd \/s \/q/.test(refusal), false, 'the refusal branch must not delete the existing lock');
  assert.match(refusal, /exit \/b 1/);
});

test('launcher: lock metadata contains only date/course/slug/created_at — no secrets, commands, or env values', () => {
  const metaBlock = LAUNCHER.slice(LAUNCHER.indexOf('>"%LOCKDIR%\\metadata.txt"'), LAUNCHER.indexOf('[3/6]'));
  assert.match(metaBlock, /echo date=%RACE_DATE%/);
  assert.match(metaBlock, /echo course=!COURSE!/);
  assert.match(metaBlock, /echo slug=%SLUG%/);
  assert.match(metaBlock, /echo created_at=/);
  assert.equal(/SECRET|KEY|TOKEN|SUPABASE|BETFAIR|RACING_API|CRON/i.test(metaBlock), false);
});

test('launcher: lock removal happens ONLY on documented no-children paths, preflight-only, or exact STOPPED', () => {
  // Every `rd /s /q "%LOCKDIR%"` must sit in one of the safe branches:
  // preflight blocked/usage, declined REVIEW, second preflight not READY,
  // preflight-only exit, initial-pipeline failure, or after STOPPED.
  const removals = LAUNCHER.match(/rd \/s \/q "%LOCKDIR%"/g) ?? [];
  assert.equal(removals.length, 6, `expected exactly 6 guarded lock removals, found ${removals.length}`);
  // The STOPPED prompt guards the final removal with an exact case-sensitive match.
  assert.match(LAUNCHER, /set \/p DONE="Type STOPPED only after the pipeline, lock and results watcher windows have all been closed: "/);
  assert.match(LAUNCHER, /if not "%DONE%"=="STOPPED" \(/);
  const stoppedIdx = LAUNCHER.indexOf('if not "%DONE%"=="STOPPED"');
  const finalRemoval = LAUNCHER.lastIndexOf('rd /s /q "%LOCKDIR%"');
  assert.ok(finalRemoval > stoppedIdx, 'the final removal comes after the STOPPED gate');
  // A non-STOPPED answer keeps the lock and re-prompts (no removal inside that branch).
  const nonStoppedBranch = LAUNCHER.slice(stoppedIdx, LAUNCHER.indexOf('goto stop_prompt', stoppedIdx) + 20);
  assert.equal(/rd \/s \/q/.test(nonStoppedBranch), false, 'generic input must never delete the lock');
  assert.match(nonStoppedBranch, /Never assume the watchers stopped/);
});

/* ------------------------ launcher: preflight gate --------------------------- */

test('launcher: preflight runs BEFORE any watcher start; first run has NO --confirm-external', () => {
  const firstPreflight = LAUNCHER.indexOf(PREFLIGHT_CALL);
  const firstStart = LAUNCHER.indexOf('start "');
  assert.ok(firstPreflight > 0 && firstStart > firstPreflight, 'preflight precedes every start');
  // The FIRST preflight INVOCATION carries --require-server but never --confirm-external.
  const firstLineEnd = LAUNCHER.indexOf('\n', firstPreflight);
  const firstLine = LAUNCHER.slice(firstPreflight, firstLineEnd);
  assert.match(firstLine, /--require-server/);
  assert.equal(firstLine.includes('--confirm-external'), false, 'first preflight must not attest externals');
  // Exit code captured immediately (redirection, not a pipe).
  assert.match(LAUNCHER, /set "PF=%ERRORLEVEL%"/);
});

test('launcher: --confirm-external appears ONLY after the exact CONTINUE attestation prompt', () => {
  const promptIdx = LAUNCHER.indexOf('set /p ACK=');
  // Count/locate INVOCATIONS carrying the flag — header comments may describe it in prose.
  const confirmInvocations = [...LAUNCHER.matchAll(/call npm run producer:preflight[^\r\n]*--confirm-external/g)];
  assert.equal(confirmInvocations.length, 1, 'exactly one attested rerun');
  assert.ok(promptIdx > 0 && confirmInvocations[0].index! > promptIdx, '--confirm-external must come after the prompt');
  // Exact, case-sensitive CONTINUE; anything else aborts with lock cleanup and no starts.
  assert.match(LAUNCHER, /if not "%ACK%"=="CONTINUE" \(/);
  assert.match(LAUNCHER, /OPERATOR ATTESTATION/);
  const declineBranch = LAUNCHER.slice(LAUNCHER.indexOf('if not "%ACK%"=="CONTINUE"'), LAUNCHER.indexOf('operator typed CONTINUE'));
  assert.match(declineBranch, /rd \/s \/q "%LOCKDIR%"/);
  assert.match(declineBranch, /exit \/b 3/);
  // The attestation is logged as a factual event.
  assert.match(LAUNCHER, /operator typed CONTINUE \(attestation of manual external checks\)/);
});

test('launcher: BLOCKED/usage preflight starts nothing, cleans the no-children lock, exits non-zero; second preflight must be READY', () => {
  assert.match(LAUNCHER, /if "%PF%"=="0" goto preflight_ready/);
  assert.match(LAUNCHER, /if "%PF%"=="3" goto preflight_review/);
  const blockedBranch = LAUNCHER.slice(LAUNCHER.indexOf('rem BLOCKED (2) or usage (1)'), LAUNCHER.indexOf(':preflight_review'));
  assert.match(blockedBranch, /rd \/s \/q "%LOCKDIR%"/);
  assert.match(blockedBranch, /exit \/b %PF%/);
  assert.equal(/start "/.test(blockedBranch), false);
  // Second preflight: only exit 0 continues.
  assert.match(LAUNCHER, /set "PF2=%ERRORLEVEL%"/);
  assert.match(LAUNCHER, /if not "%PF2%"=="0" \(/);
});

test('launcher: --preflight-only prints the plan + URLs, starts nothing, and removes its own lock before exit 0', () => {
  assert.match(LAUNCHER, /if \/i "%MODE%"=="--preflight-only" set "PREFLIGHT_ONLY=1"/);
  const blockStart = LAUNCHER.indexOf('if "%PREFLIGHT_ONLY%"=="1"');
  const blockEnd = LAUNCHER.indexOf('[4/6]');
  assert.ok(blockStart > 0 && blockEnd > blockStart, 'preflight-only block precedes the initial pipeline');
  const block = LAUNCHER.slice(blockStart, blockEnd);
  assert.match(block, /pipeline:watch -- --date %RACE_DATE% --course "!COURSE!" --interval-minutes 5 --commit/);
  assert.match(block, /lock:t-minus -- --date %RACE_DATE% --course "!COURSE!" --minutes-before 5 --commit/);
  assert.match(block, /results:auto -- --date %RACE_DATE% --course "!COURSE!"/);
  assert.match(block, /Local dashboard:\s+!LOCAL_URL!/);
  assert.match(block, /Production dashboard: not configured/);
  assert.match(block, /rd \/s \/q "%LOCKDIR%"/);
  assert.match(block, /exit \/b 0/);
  assert.equal(/start "/.test(block), false, 'preflight-only must not start windows');
});

/* ------------------- launcher: initial pipeline + watchers ------------------- */

test('launcher: a failed initial pipeline:day launches ZERO watcher windows and cleans the no-children lock', () => {
  const pdIdx = LAUNCHER.indexOf(PIPELINE_DAY_CALL);
  const firstStart = LAUNCHER.indexOf('start "PIPELINE WATCH');
  assert.ok(pdIdx > 0 && firstStart > pdIdx, 'initial pipeline precedes the watcher windows');
  assert.match(LAUNCHER, /set "PD=%ERRORLEVEL%"/);
  const failBranch = LAUNCHER.slice(LAUNCHER.indexOf('if not "%PD%"=="0"'), firstStart);
  assert.match(failBranch, /NO watcher windows/);
  assert.match(failBranch, /rd \/s \/q "%LOCKDIR%"/);
  assert.match(failBranch, /exit \/b %PD%/);
  assert.equal(/start "/.test(failBranch), false);
});

test('launcher: exactly three watcher windows, each receiving the validated date/course/logdir', () => {
  assert.match(LAUNCHER, /start "PIPELINE WATCH %RACE_DATE% %COURSE%".*watch-pipeline\.bat" %RACE_DATE% "%COURSE%" "%LOGDIR%""/);
  assert.match(LAUNCHER, /start "LOCK WATCH %RACE_DATE% %COURSE%".*watch-locks\.bat" %RACE_DATE% "%COURSE%" "%LOGDIR%""/);
  assert.match(LAUNCHER, /start "RESULTS WATCH %RACE_DATE% %COURSE%".*watch-results\.bat" %RACE_DATE% "%COURSE%" "%LOGDIR%""/);
  assert.equal((LAUNCHER.match(/start "/g) ?? []).length, 3, 'exactly three windows');
});

test('launcher: dashboard URLs are displayed from the validated helper output; no Railway host is hardcoded anywhere', () => {
  assert.match(LAUNCHER, /Local dashboard:\s+!LOCAL_URL!/);
  assert.match(LAUNCHER, /if "!PROD_URL!"=="not-configured" \(/);
  assert.match(LAUNCHER, /Production dashboard: not configured/);
  assert.match(LAUNCHER, /Production dashboard: !PROD_URL!/);
  for (const src of [...ALL_BATS, RUNBOOK]) {
    assert.equal(/railway\.app/i.test(src), false, 'no hardcoded Railway host');
  }
});

test('launcher: never releases the database claim; logs the lifecycle to supervisor.log', () => {
  // The statement is echoed across two batch lines, so match the two phrases.
  assert.match(LAUNCHER, /This launcher never/);
  assert.match(LAUNCHER, /releases the database claim directly/);
  assert.equal(/producer:claim-check[^\r\n]*--op (release|claim|heartbeat)/.test(LAUNCHER), false);
  for (const event of ['launcher start', 'local lock acquired', 'preflight run 1 exit', 'initial pipeline:day exit', 'operator typed STOPPED']) {
    assert.ok(LAUNCHER.includes(event), `supervisor.log event missing: ${event}`);
  }
});

/* --------------------------- pipeline watcher wrapper ------------------------ */

test('pipeline wrapper: is a THIN launcher — runs the Node helper synchronously via plain `node`, NO PowerShell / Tee-Object INVOCATION / cmd retry loop', () => {
  assert.match(PIPELINE, /node "%~dp0run-pipeline-watch\.js" "%RACE_DATE%" "%COURSE%" "%LOGDIR%"/);
  assert.match(PIPELINE, /set "CODE=%ERRORLEVEL%"/);
  assert.match(PIPELINE, /exit \/b %CODE%/);
  // The fragile chain that broke graceful Ctrl+C is gone. Scan for actual
  // INVOCATION syntax, not the words (the header comment explains what it
  // replaced): `powershell -<flag>`, a `| Tee-Object` pipe, and any cmd
  // retry loop label/jump.
  assert.equal(/powershell\s+-/i.test(PIPELINE), false, 'no PowerShell invocation in the thin launcher');
  assert.equal(/\|\s*Tee-Object/i.test(PIPELINE), false, 'no Tee-Object pipeline in the thin launcher');
  assert.equal(/^:loop\b|goto loop/m.test(PIPELINE), false, 'no cmd retry loop in the thin launcher (owned by the helper)');
});

test('pipeline wrapper + helper: launches npm.cmd via %ComSpec% cmd.exe (NOT a direct .cmd spawn, which throws EINVAL on modern Node); never a .ps1 command; no execution-policy change/bypass', () => {
  for (const src of [...ALL_BATS, HELPER]) {
    // A quoted/command-position `.ps1` (prose may say "never the .ps1 shim"
    // without quoting it — that is documentation, not an invocation).
    assert.equal(/['"]npm\.ps1['"]|npm\.ps1\s/i.test(src), false, 'no npm.ps1 command');
    assert.equal(/Set-ExecutionPolicy/i.test(src), false, 'no execution-policy change');
    assert.equal(/ExecutionPolicy\s+Bypass/i.test(src), false, 'no execution-policy bypass');
  }
  // The EINVAL fix: the helper resolves %ComSpec% and runs cmd.exe /d /s /c
  // "<inner>", with windowsVerbatimArguments so the command line is passed
  // through unescaped. It must NOT spawn a .cmd file directly.
  assert.match(HELPER, /process\.env\.ComSpec \|\| process\.env\.COMSPEC \|\| 'cmd\.exe'/);
  assert.match(HELPER, /'\/d', '\/s', '\/c'/);
  assert.match(HELPER, /windowsVerbatimArguments: true/);
  assert.match(HELPER, /npm\.cmd run pipeline:watch/);
  // No direct `.cmd`/`.bat` executable handed to spawn (the thing that broke).
  assert.equal(/spawn(Fn)?\(\s*['"][^'"]*\.(cmd|bat)['"]/i.test(HELPER), false, 'never spawn a .cmd/.bat directly');
  assert.equal(/runWatcherProcess\(spawn, 'npm\.cmd'/.test(HELPER), false, 'the watcher is launched via cmd.exe, not npm.cmd directly');
  // Still no shell:true (we build the exact command line ourselves).
  assert.match(HELPER, /shell: false/);
});

test('helper: spawns non-detached with stdout/stderr piped-and-teed and stdin inherited (child stays in this console for Ctrl+C)', () => {
  assert.match(HELPER, /stdio: \['inherit', 'pipe', 'pipe'\]/);
  assert.equal(/detached:\s*true/.test(HELPER), false, 'child must never be detached');
  // Both streams are teed to console AND the append-only log.
  assert.match(HELPER, /child\.stdout\.on\('data'/);
  assert.match(HELPER, /child\.stderr\.on\('data'/);
  assert.match(HELPER, /appendFileSync/);
  assert.match(HELPER, /createWriteStream|appendFileSync/); // append-only writer
});

test('helper: first SIGINT WAITS (never process.exit, never kills the child); a second SIGINT is the explicit force path', () => {
  // The whole point of the fix: on the first Ctrl+C the helper must not exit or
  // kill — it lets the watcher run its finally-release and awaits child exit.
  const firstPressStart = HELPER.indexOf('if (sigintCount === 1) {');
  const elseIdx = HELPER.indexOf('} else {', firstPressStart);
  assert.ok(firstPressStart > 0 && elseIdx > firstPressStart, 'first-press / else branches present');
  const firstPressBlock = HELPER.slice(firstPressStart, elseIdx);
  assert.match(firstPressBlock, /waiting for pipeline:watch to release its claim/);
  assert.equal(/process\.exit/.test(firstPressBlock), false, 'first SIGINT must NOT process.exit');
  assert.equal(/\.kill\(/.test(firstPressBlock), false, 'first SIGINT must NOT kill the child');
  // Second press: explicit force-stop (the ONLY place the child is killed).
  const elseBlock = HELPER.slice(elseIdx, HELPER.indexOf('});', elseIdx));
  assert.match(elseBlock, /second Ctrl\+C/);
  assert.match(elseBlock, /currentChild\.kill\(\)/);
});

test('helper: exit-code policy — 0 graceful / 2 mechanism / 3 ownership / 86 config are terminal; generic non-zero is bounded-retried; an interrupt is never retried', () => {
  assert.match(HELPER, /stopped GRACEFULLY \(exit 0\)/);
  assert.match(HELPER, /OWNERSHIP refused or lost \(exit 3\)/);
  assert.match(HELPER, /mechanism unavailable\/uncertain \(exit 2\)/);
  assert.match(HELPER, /npm\.cmd could not be executed/);
  assert.match(HELPER, /Max \$\{MAX_RETRIES\} bounded retries reached/);
  // The policy codes short-circuit BEFORE any interrupt reasoning.
  assert.match(HELPER, /if \(code === 0\) return 'terminal_graceful';/);
  assert.match(HELPER, /if \(code === CONFIG_FAILURE_CODE\) return 'terminal_config';/);
});

test('helper: "force-stopped" is reachable ONLY via a SECOND interrupt; a single Ctrl+C with confirmed clean shutdown normalises to graceful', () => {
  // The live defect was labelling npm/cmd.exe's post-Ctrl+C exit 1 a force-stop.
  assert.match(HELPER, /if \(secondInterrupt\) return 'terminal_forced';/);
  assert.match(HELPER, /if \(firstInterrupt && gracefulConfirmed\) return 'terminal_graceful_normalised';/);
  assert.match(HELPER, /if \(firstInterrupt\) return 'terminal_interrupted_unclean';/);
  // The operator-facing message only claims a force-stop for a second Ctrl+C.
  assert.match(HELPER, /force-stopped by operator — a SECOND Ctrl\+C was received/);
  // Evidence is structured markers, not prose matching.
  assert.match(HELPER, /const GRACEFUL_MARKER = 'WATCH_STOPPED_GRACEFULLY'/);
  assert.match(HELPER, /const RELEASE_FAILED_MARKER = 'PRODUCER_CLAIM_RELEASE_FAILED'/);
  assert.match(HELPER, /gracefulConfirmed: sawGracefulMarker && !sawReleaseFailed/);
  // Classification must happen only after all output drained ('close', not 'exit').
  assert.match(HELPER, /child\.on\('close'/);
});

test('watcher: emits the structured graceful marker only after a clean stop (no error exit code set)', () => {
  const watcher = readFileSync('scripts/runRaceDayPipelineWatch.ts', 'utf8');
  assert.match(watcher, /if \(!process\.exitCode\) \{\s*\r?\n\s*console\.log\('WATCH_STOPPED_GRACEFULLY'\);/);
  // It sits AFTER the finally that releases the claim, so it proves shutdown completed.
  const finallyIdx = watcher.indexOf('await releaseProducerOwnership(');
  const markerIdx = watcher.indexOf("console.log('WATCH_STOPPED_GRACEFULLY')");
  assert.ok(finallyIdx > 0 && markerIdx > finallyIdx, 'marker must follow the release');
});

test('helper: is claim-exempt and provider/model-free — spawns ONLY pipeline:watch, touches no DB/claim/provider', () => {
  assert.match(HELPER, /npm\.cmd run pipeline:watch/);
  // No other npm script, no claim/RPC/provider/model surface.
  assert.equal(/pipeline:day|lock:t-minus|results:auto|run:model|model:day/.test(HELPER), false);
  assert.equal(/producer_run_claims|producerClaim|producerOwnership|tryAcquire|heartbeat|releaseProducer|--op (claim|heartbeat|release)/i.test(HELPER), false);
  assert.equal(/supabaseAdmin|@supabase|createClient|racingApi|betfair/i.test(HELPER), false);
  // No secrets, no betting/order tokens.
  assert.equal(/SERVICE_ROLE|CRON_SECRET|RACING_API_KEY|BETFAIR_|Authorization|placeBet|placeOrder|submitOrder/i.test(HELPER), false);
  // Runs only as an entrypoint; pure pieces are exported for tests.
  assert.match(HELPER, /if \(require\.main === module\)/);
  assert.match(HELPER, /module\.exports = \{/);
});

test('launcher + pipeline wrapper establish UTF-8 (chcp 65001) before any output; helper writes UTF-8 explicitly; locks/results untouched', () => {
  for (const [name, src] of [['launcher', LAUNCHER], ['pipeline wrapper', PIPELINE]] as const) {
    const chcpIdx = src.indexOf('chcp 65001 >nul');
    assert.ok(chcpIdx > 0, `${name}: chcp 65001 present`);
    const firstOutputIdx = src.search(/\r?\n\s*(echo[. ]|type |node )/);
    assert.ok(firstOutputIdx > 0 && chcpIdx < firstOutputIdx, `${name}: chcp precedes the first output/child launch`);
  }
  // The helper's single log writer is explicitly UTF-8 (no mixed encoding).
  assert.match(HELPER, /Buffer\.from\(chunk, 'utf8'\)/);
  for (const src of [LOCKS, RESULTS]) {
    assert.equal(/chcp/.test(src), false, 'claim-exempt watchers stay byte-identical (no chcp)');
  }
});

/* ------------------------- lock + results watchers --------------------------- */

test('lock watcher: business rules unchanged — lock:t-minus --minutes-before 5 --commit every 120 seconds', () => {
  assert.match(LOCKS, /npm run lock:t-minus -- --date %RACE_DATE% --course "%COURSE%" --minutes-before 5 --commit/);
  assert.match(LOCKS, /timeout \/t 120 \/nobreak/);
  assert.match(LOCKS, /:loop/);
  assert.match(LOCKS, /goto loop/);
  assert.doesNotMatch(LOCKS, /delete|update|upsert|locked_decisions_admin/i);
});

test('results watcher: business rules unchanged — DRY-RUN first, --commit only when clean, every 10 minutes', () => {
  const dryIdx = RESULTS.indexOf('npm run results:auto -- --date %RACE_DATE% --course "%COURSE%" >>');
  const commitIdx = RESULTS.indexOf('npm run results:auto -- --date %RACE_DATE% --course "%COURSE%" --commit');
  assert.ok(dryIdx >= 0, 'dry-run call present');
  assert.ok(commitIdx > dryIdx, 'commit call comes after the dry-run');
  assert.match(RESULTS, /if errorlevel 1 \(/);
  assert.match(RESULTS, /SKIPPING commit/);
  assert.match(RESULTS, /timeout \/t 600 \/nobreak/);
});

test('lock/results watchers are claim-exempt: no ownership or preflight vocabulary at all', () => {
  for (const src of [LOCKS, RESULTS]) {
    assert.equal(/producer|claim|owner|preflight/i.test(src), false);
  }
});

/* ------------------------------ safety scans --------------------------------- */

test('batch files call ONLY the approved npm scripts — no direct DB/API/betting access, no secrets, no nationwide scope', () => {
  const ALLOWED = new Set([
    'pipeline:day',
    'pipeline:watch',
    'lock:t-minus',
    'results:auto',
    'producer:preflight',
    'producer:claim-check', // appears only as printed operator GUIDANCE, never with a mutating --op
    'race-day:launch-check',
  ]);
  for (const src of ALL_BATS) {
    for (const m of src.matchAll(/npm run (?:--silent )?([a-z:-]+)/g)) {
      assert.ok(ALLOWED.has(m[1]), `unexpected npm script: ${m[1]}`);
    }
    // Scan for actual DB/HTTP ACCESS patterns — the word "Supabase" may appear
    // in printed operator guidance ("investigate Supabase reachability").
    assert.doesNotMatch(src, /supabaseAdmin|@supabase|createClient|psql|curl |Invoke-WebRequest|Invoke-RestMethod/i);
    assert.doesNotMatch(src, /placeBet|placeOrder|submitOrder|betfair/i);
    assert.doesNotMatch(src, /SERVICE_ROLE|CRON_SECRET|RACING_API_KEY|BETFAIR_|Authorization/);
    assert.equal(/all-uk-ire|all uk ire/i.test(src), false, 'no nationwide scope in any bat');
  }
  // Only the pipeline watcher runs pipeline:watch; lock/results never run provider/model commands.
  assert.equal(/pipeline:watch/.test(LOCKS) || /pipeline:watch/.test(RESULTS), false);
  assert.equal(/pipeline:day/.test(PIPELINE) || /pipeline:day/.test(LOCKS) || /pipeline:day/.test(RESULTS), false);
});

/* -------------------------------- runbook ------------------------------------ */

test('runbook documents the new contract: required args, preflight gate, CONTINUE, --preflight-only, STOPPED, stale-lock recovery', () => {
  assert.match(RUNBOOK, /start-race-day\.bat YYYY-MM-DD "Course Name"/);
  assert.match(RUNBOOK, /--preflight-only/);
  assert.match(RUNBOOK, /CONTINUE/);
  assert.match(RUNBOOK, /STOPPED/);
  assert.match(RUNBOOK, /supervisor\.lock/);
  assert.match(RUNBOOK, /PUBLIC_DASHBOARD_URL/);
  assert.match(RUNBOOK, /never deletes .*lock automatically|never deleted automatically/i);
  assert.match(RUNBOOK, /dry-run first/i);
  assert.match(RUNBOOK, /no auto-betting, no bet placement/i);
  assert.match(RUNBOOK, /MANUAL_RESULTS_IMPORT/);
});
