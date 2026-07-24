'use strict';
/*
 * Pipeline-watch runner helper (Windows graceful-Ctrl+C fix) —
 * Phase 7A.2b Step 4 correction.
 *
 * The previous wrapper orchestrated `npm.cmd ... | Tee-Object` from a cmd
 * batch. On Ctrl+C, Windows broadcasts CTRL_C_EVENT to the whole console
 * process group: PowerShell 5.1's pipeline StopProcessing hard-killed the
 * watcher's Node process mid-`await` of its release RPC (so
 * PRODUCER_CLAIM_RELEASED never landed), and the batch itself was torn down
 * before it could capture the exit code or print GRACEFUL. See
 * docs/LOCAL_RACE_DAY_SUPERVISOR.md.
 *
 * This helper is ONE long-lived Node process that owns the whole lifecycle:
 *   - it launches the watcher as a NATIVE node child — `process.execPath
 *     --import <resolved tsx loader URL> scripts/runRaceDayPipelineWatch.ts
 *     --date … --course … --interval-minutes 5 --commit` — with `shell:false`
 *     and `detached:false`, so the watcher runs IN THAT SAME node process (the
 *     tsx loader is in-process; verified: no grandchild) and receives Ctrl+C
 *     DIRECTLY from the console, running its own SIGINT `finally` release to
 *     completion with its stdio wired straight to us.
 *
 *     There is deliberately NO npm, npm.cmd, npm.ps1, cmd.exe/ComSpec,
 *     PowerShell, shell execution or .cmd/.bat anywhere in this chain. Earlier
 *     revisions used PowerShell + Tee-Object (which hard-killed the watcher on
 *     Ctrl+C before its release could finish) and then cmd.exe via ComSpec
 *     (needed because directly spawning the npm.cmd shim throws `EINVAL` since
 *     Node 18.20.2/20.12.2, CVE-2024-27980) — but cmd.exe then sat in the
 *     long-running signal path and its "Terminate batch job (Y/N)?" handling
 *     tore down the child's output before the release/graceful markers reached
 *     this helper. Going straight to node+tsx removes that whole class of
 *     failure: the date/course are ARGV ELEMENTS, never command text, so no
 *     quoting is involved at all;
 *   - it registers a SIGINT handler and DOES NOT exit on the first Ctrl+C —
 *     it just waits for the child to finish and emit PRODUCER_CLAIM_RELEASED;
 *   - it tees the child's stdout/stderr to BOTH the live console and an
 *     append-only, deterministic-UTF-8 pipeline-watch.log;
 *   - it captures the child's REAL numeric exit code and classifies it with
 *     the same policy as before (0 graceful / 2 mechanism / 3 ownership / 86
 *     config — all terminal; generic non-zero bounded-retry <=5 at 60s);
 *   - once a Ctrl+C has been received the run is operator-terminal and is
 *     NEVER retried.
 *
 * The exit-code policy mirrors classifyPipelineWatchExit +
 * MAX_PIPELINE_WATCH_RETRIES + PIPELINE_WATCH_RETRY_DELAY_SECONDS in
 * src/lib/raceDayLauncher.ts (cross-checked by scripts/raceDaySupervisor.test.ts),
 * extended with 86 = wrapper configuration failure exactly as the old batch did.
 *
 * SAFETY: this helper NEVER touches the database or the producer claim itself
 * (pipeline:watch owns and releases the claim), makes NO provider/model call
 * of its own, spawns ONLY `npm run pipeline:watch`, never detaches the child,
 * and prints/logs no secrets (it neither reads nor forwards credentials).
 * Decision-support only — no betting, no bet placement.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/** Bounded-retry policy — mirrors src/lib/raceDayLauncher.ts (verified by test). */
const MAX_RETRIES = 5;
const RETRY_DELAY_SECONDS = 60;

/** Terminal wrapper-configuration exit code (npm.cmd unrunnable / bad log dir / bad args). */
const CONFIG_FAILURE_CODE = 86;

/** The documented Windows-safe course charset (mirrors SAFE_COURSE_RE in raceDayLauncher.ts). */
const SAFE_COURSE_RE = /^[A-Za-z0-9 '().-]+$/;

/* -------------------------------------------------------------------------- */
/* Pure helpers (exported for unit tests)                                     */
/* -------------------------------------------------------------------------- */

/** The structured marker the watcher prints after a clean stop + successful shutdown. */
const GRACEFUL_MARKER = 'WATCH_STOPPED_GRACEFULLY';

/** The structured event the ownership layer logs when the claim release FAILED. */
const RELEASE_FAILED_MARKER = 'PRODUCER_CLAIM_RELEASE_FAILED';

/**
 * Classifies a watcher exit from the child's exit code plus the evidence the
 * helper actually observed.
 *
 * `evidence`:
 *   - `firstInterrupt`     : at least one Ctrl+C reached this helper.
 *   - `secondInterrupt`    : a SECOND Ctrl+C reached it (the genuine force path).
 *   - `gracefulConfirmed`  : the child printed {@link GRACEFUL_MARKER} AND never
 *                            printed {@link RELEASE_FAILED_MARKER} — i.e. the
 *                            watcher provably completed its shutdown and its
 *                            claim release succeeded.
 *
 * The policy codes 0/2/3/86 always win, unchanged. For any OTHER non-zero code
 * (notably the 1 that npm/cmd.exe reports after a console Ctrl+C even when the
 * watcher stopped cleanly):
 *   - a SECOND interrupt   -> `terminal_forced` (only ever labelled force-stop here);
 *   - one interrupt + confirmed graceful completion -> `terminal_graceful_normalised`
 *     (effective exit 0 — the shell's code is normalised, never invented);
 *   - one interrupt WITHOUT confirmation -> `terminal_interrupted_unclean`
 *     (stays non-zero and visibly terminal — cleanup may not have completed);
 *   - no interrupt at all  -> `retryable` (an ordinary crash; bounded retry).
 * Pure.
 */
function classifyExit(code, evidence) {
  const ev = evidence || {};
  const firstInterrupt = ev.firstInterrupt === true;
  const secondInterrupt = ev.secondInterrupt === true;
  const gracefulConfirmed = ev.gracefulConfirmed === true;

  if (code === 0) return 'terminal_graceful';
  if (code === 2) return 'terminal_mechanism';
  if (code === 3) return 'terminal_ownership';
  if (code === CONFIG_FAILURE_CODE) return 'terminal_config';

  if (secondInterrupt) return 'terminal_forced';
  if (firstInterrupt && gracefulConfirmed) return 'terminal_graceful_normalised';
  if (firstInterrupt) return 'terminal_interrupted_unclean';
  return 'retryable';
}

/** The effective process exit code for a classification (graceful paths normalise to 0). Pure. */
function effectiveExitCode(classification, code) {
  if (classification === 'terminal_graceful' || classification === 'terminal_graceful_normalised') return 0;
  if (classification === 'terminal_mechanism') return 2;
  if (classification === 'terminal_ownership') return 3;
  if (classification === 'terminal_config') return CONFIG_FAILURE_CODE;
  return code;
}

/** True only for the one retryable class; every terminal class stops. Pure. */
function isRetryable(classification) {
  return classification === 'retryable';
}

/**
 * Validates the three positional args. Returns { ok, date, course, logdir } or
 * { ok:false, error }. Strict date; non-empty course/logdir. Pure.
 */
function validateArgs(argv) {
  const [date, course, logdir] = argv;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: `invalid or missing date "${date || ''}" (expected YYYY-MM-DD)` };
  }
  // Strict calendar validity (rejects 2026-13-40 etc.) via a UTC round-trip —
  // the same rule the rest of the codebase's date validators use.
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    return { ok: false, error: `invalid calendar date "${date}"` };
  }
  if (!course || course.trim() === '') return { ok: false, error: 'a course is required' };
  // Windows-safe charset (defense-in-depth for the cmd.exe command line — the
  // launcher's race-day:launch-check enforces the same set upstream). Excludes
  // the double-quote and every cmd metacharacter, so double-quoting is safe.
  if (!SAFE_COURSE_RE.test(course)) {
    return { ok: false, error: `course "${course}" contains unsupported characters (letters, digits, spaces, hyphen, apostrophe, parentheses, period only)` };
  }
  if (!logdir || logdir.trim() === '') return { ok: false, error: 'a log directory is required' };
  return { ok: true, date, course, logdir };
}

/** The repository root — this helper lives in `<repo>/race-day-local/`. */
function repoRoot() {
  return path.resolve(__dirname, '..');
}

/** The watcher's TypeScript entrypoint: deterministic and repository-local. */
function watcherScriptPath() {
  return path.join(repoRoot(), 'scripts', 'runRaceDayPipelineWatch.ts');
}

/**
 * Resolves the INSTALLED tsx ESM loader through ordinary package resolution
 * (`require.resolve('tsx')` — never a hardcoded node_modules path) and returns
 * it as a `file:` URL, which is what `node --import` expects on Windows (it
 * percent-encodes spaces in the repo path). Throws when tsx is not installed;
 * the caller maps that to the terminal 86 configuration failure.
 */
function resolveTsxLoaderUrl() {
  return pathToFileURL(require.resolve('tsx')).href;
}

/**
 * The exact node argv for the watcher:
 *   --import <tsx loader URL> <watcher.ts> --date D --course C --interval-minutes 5 --commit
 *
 * Passed as an ARGV ARRAY with shell:false, so the date and course are handed
 * to the child as discrete arguments and can NEVER become executable command
 * text — no quoting function is needed or used anywhere. Pure.
 */
function buildWatcherNodeArgs(loaderUrl, scriptPath, date, course) {
  return [
    '--import',
    loaderUrl,
    scriptPath,
    '--date',
    date,
    '--course',
    course,
    '--interval-minutes',
    '5',
    '--commit',
  ];
}

/* -------------------------------------------------------------------------- */
/* Process orchestration                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Spawns a child, tees stdout/stderr through `onData`, and resolves with the
 * child's real numeric exit code (or 86 on a spawn error). Never detaches.
 * `spawnFn` is injectable for tests; production passes node's spawn with
 * `process.execPath` (see main). `extraSpawnOpts` merges into the spawn options
 * (production sets `cwd` to the repository root so the watcher's own
 * `.env.local` lookup resolves). `onChild` receives the ChildProcess so the
 * caller can force-kill on a second Ctrl+C.
 */
function runWatcherProcess(spawnFn, command, args, onData, onChild, extraSpawnOpts) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    let child;
    try {
      child = spawnFn(command, args, {
        // shell:false + detached:false → a native child in THIS console process
        // group: it receives Ctrl+C directly and its stdio stays wired to us.
        shell: false,
        detached: false,
        stdio: ['inherit', 'pipe', 'pipe'],
        windowsHide: false,
        ...(extraSpawnOpts || {}),
      });
    } catch (err) {
      onData(`[helper] ${command} could not be started: ${err && err.message ? err.message : String(err)}\n`);
      finish(CONFIG_FAILURE_CODE);
      return;
    }
    if (onChild) onChild(child);
    child.on('error', (err) => {
      // ENOENT / EINVAL etc. — the command processor could not be executed.
      onData(`[helper] ${command} could not be executed (${err && err.code ? err.code : (err && err.message) || 'error'})\n`);
      finish(CONFIG_FAILURE_CODE);
    });
    if (child.stdout) child.stdout.on('data', (d) => onData(d));
    if (child.stderr) child.stderr.on('data', (d) => onData(d));
    // Capture the code on 'exit' but resolve on 'close': 'close' fires only once
    // the stdio streams have drained, which GUARANTEES every `onData` chunk (and
    // therefore the watcher's terminal marker) has been observed before the
    // caller classifies. Resolving on 'exit' could race the final chunk.
    let exitCode = null;
    let exitSignal = null;
    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
    child.on('close', () => {
      // A null code means the child was killed by a signal (e.g. forced stop).
      finish(exitCode === null ? (exitSignal ? 130 : 1) : exitCode);
    });
  });
}

/** Interruptible sleep: resolves 'slept' after ms, or 'interrupted' if `signal.aborted`. */
function interruptibleSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve('interrupted');
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve('slept');
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve('interrupted');
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/* -------------------------------------------------------------------------- */
/* main()                                                                     */
/* -------------------------------------------------------------------------- */

async function main() {
  const parsed = validateArgs(process.argv.slice(2));
  if (!parsed.ok) {
    // Config failure: never graceful, never retried.
    process.stderr.write(`[helper] configuration error: ${parsed.error}\n`);
    process.exit(CONFIG_FAILURE_CODE);
    return;
  }
  const { date, course, logdir } = parsed;

  try {
    fs.mkdirSync(logdir, { recursive: true });
  } catch (err) {
    process.stderr.write(`[helper] configuration error: cannot create log directory "${logdir}" (${err && err.message ? err.message : String(err)})\n`);
    process.exit(CONFIG_FAILURE_CODE);
    return;
  }
  const logPath = path.join(logdir, 'pipeline-watch.log');

  // Single append-only UTF-8 writer (synchronous → always flushed before exit;
  // no mixed encoding). Also mirrors to the live console.
  const logAppend = (chunk) => {
    try {
      fs.appendFileSync(logPath, typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    } catch {
      // Logging must never crash the watcher supervision.
    }
  };
  const emit = (line) => {
    const s = line.endsWith('\n') ? line : `${line}\n`;
    process.stdout.write(s);
    logAppend(s);
  };
  // Rolling scan for the watcher's structured terminal markers. A bounded
  // window handles a marker split across two chunks; the booleans latch once
  // seen. Reset per watcher invocation (see the loop) so evidence is never
  // carried over from an earlier, retried run.
  let scanWindow = '';
  let sawGracefulMarker = false;
  let sawReleaseFailed = false;
  const scan = (chunk) => {
    scanWindow = (scanWindow + chunk.toString('utf8')).slice(-2048);
    if (!sawGracefulMarker && scanWindow.includes(GRACEFUL_MARKER)) sawGracefulMarker = true;
    if (!sawReleaseFailed && scanWindow.includes(RELEASE_FAILED_MARKER)) sawReleaseFailed = true;
  };
  const onData = (d) => {
    process.stdout.write(d);
    logAppend(d);
    scan(d);
  };

  // Resolve the tsx loader through package resolution. A missing/broken tsx is
  // a TERMINAL configuration failure (86) — never graceful, never retried.
  let loaderUrl;
  try {
    loaderUrl = resolveTsxLoaderUrl();
  } catch (err) {
    const why = err && err.message ? err.message : String(err);
    process.stderr.write(`[helper] configuration error: could not resolve the tsx loader (${why}). Run npm install.\n`);
    process.exit(CONFIG_FAILURE_CODE);
    return;
  }
  const scriptPath = watcherScriptPath();
  if (!fs.existsSync(scriptPath)) {
    process.stderr.write(`[helper] configuration error: watcher script not found at ${scriptPath}\n`);
    process.exit(CONFIG_FAILURE_CODE);
    return;
  }
  const nodeArgs = buildWatcherNodeArgs(loaderUrl, scriptPath, date, course);
  let sigintCount = 0;
  let currentChild = null;
  const retryAbort = new AbortController();

  process.on('SIGINT', () => {
    sigintCount += 1;
    if (sigintCount === 1) {
      // Do NOT exit and do NOT force-stop: the console already delivered Ctrl+C
      // to the watcher (same group); it is running its finally-release now. Just
      // wait for it. (A synthetic signal to the child cannot deliver a real
      // Ctrl+C on Windows, so forwarding one would not help.)
      emit('[helper] Ctrl+C received — waiting for pipeline:watch to release its claim and exit gracefully… (press Ctrl+C again to force)');
      retryAbort.abort(); // if we happen to be in an inter-retry wait, stop retrying
    } else {
      emit('[helper] second Ctrl+C — force-stopping the child now (its claim, if not yet released, will TTL-expire).');
      if (currentChild) {
        try {
          currentChild.kill();
        } catch {
          // best effort
        }
      }
    }
  });

  let retries = 0;
  for (;;) {
    // Per-invocation evidence: never carry a marker over from an earlier run.
    scanWindow = '';
    sawGracefulMarker = false;
    sawReleaseFailed = false;

    emit('[helper] pipeline:watch starting (interval 5 min, --commit) — native node + tsx loader, no shell…');
    const code = await runWatcherProcess(
      spawn,
      process.execPath,
      nodeArgs,
      onData,
      (c) => {
        currentChild = c;
      },
      { cwd: repoRoot() },
    );
    currentChild = null;
    emit(`[helper] pipeline:watch exited with code ${code}`);

    const evidence = {
      firstInterrupt: sigintCount >= 1,
      secondInterrupt: sigintCount >= 2,
      gracefulConfirmed: sawGracefulMarker && !sawReleaseFailed,
    };
    const cls = classifyExit(code, evidence);
    if (cls === 'terminal_graceful') {
      emit('[helper] TERMINAL: pipeline:watch stopped GRACEFULLY (exit 0). Not restarting — this was a deliberate stop.');
      process.exit(0);
    }
    if (cls === 'terminal_graceful_normalised') {
      emit(
        `[helper] TERMINAL: pipeline:watch stopped GRACEFULLY after Ctrl+C — the watcher confirmed clean shutdown ` +
          `(${GRACEFUL_MARKER}) and released its claim, so the shell's exit ${code} (npm/cmd.exe report a non-zero ` +
          `code on a console Ctrl+C) is normalised to an effective 0. Not restarting.`,
      );
      process.exit(0);
    }
    if (cls === 'terminal_forced') {
      emit(`[helper] TERMINAL: force-stopped by operator — a SECOND Ctrl+C was received (exit ${code}). Not restarting.`);
      process.exit(code);
    }
    if (cls === 'terminal_interrupted_unclean') {
      emit(
        `[helper] TERMINAL: interrupted by Ctrl+C but clean shutdown was NOT confirmed (exit ${code}; no ` +
          `${GRACEFUL_MARKER}${sawReleaseFailed ? `, and ${RELEASE_FAILED_MARKER} was reported` : ''}). ` +
          `The claim may still be held — check: npm run producer:claim-check -- --date ${date}. Not restarting.`,
      );
      process.exit(code);
    }
    if (cls === 'terminal_ownership') {
      emit('[helper] TERMINAL: producer OWNERSHIP refused or lost (exit 3). Another producer holds/took the date; restarting cannot help. Inspect: npm run producer:claim-check -- --date ' + date);
      process.exit(3);
    }
    if (cls === 'terminal_mechanism') {
      emit('[helper] TERMINAL: claim mechanism unavailable/uncertain (exit 2). Fail-closed — no provider/model work ran after the failure. Not restarting.');
      process.exit(2);
    }
    if (cls === 'terminal_config') {
      emit('[helper] TERMINAL: the watcher could not be launched (config failure, exit 86). No pipeline work ran. Check the Node.js/tsx installation (npm install). Not retrying.');
      process.exit(CONFIG_FAILURE_CODE);
    }

    // retryable (a genuine crash, no Ctrl+C)
    retries += 1;
    if (retries > MAX_RETRIES) {
      emit(`[helper] TERMINAL: pipeline:watch failed ${retries} times (last exit ${code}). Max ${MAX_RETRIES} bounded retries reached — staying DEGRADED, not looping.`);
      process.exit(code);
    }
    emit(`[helper] [WARN] pipeline:watch exit ${code} — bounded retry ${retries}/${MAX_RETRIES} in ${RETRY_DELAY_SECONDS}s.`);
    const slept = await interruptibleSleep(RETRY_DELAY_SECONDS * 1000, retryAbort.signal);
    if (slept === 'interrupted' || sigintCount > 0) {
      emit('[helper] retry aborted — operator stop. Not restarting.');
      process.exit(code);
    }
  }
}

module.exports = {
  MAX_RETRIES,
  RETRY_DELAY_SECONDS,
  CONFIG_FAILURE_CODE,
  SAFE_COURSE_RE,
  GRACEFUL_MARKER,
  RELEASE_FAILED_MARKER,
  classifyExit,
  effectiveExitCode,
  isRetryable,
  validateArgs,
  repoRoot,
  watcherScriptPath,
  resolveTsxLoaderUrl,
  buildWatcherNodeArgs,
  runWatcherProcess,
  interruptibleSleep,
};

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[helper] fatal: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
