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
 *   - it spawns `npm.cmd run pipeline:watch ...` NON-DETACHED in the same
 *     console (shell:false, never npm.ps1), so the watcher receives Ctrl+C
 *     DIRECTLY from the console and runs its own SIGINT `finally` release to
 *     completion (nothing kills it early);
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

/** Bounded-retry policy — mirrors src/lib/raceDayLauncher.ts (verified by test). */
const MAX_RETRIES = 5;
const RETRY_DELAY_SECONDS = 60;

/** Terminal wrapper-configuration exit code (npm.cmd unrunnable / bad log dir / bad args). */
const CONFIG_FAILURE_CODE = 86;

/* -------------------------------------------------------------------------- */
/* Pure helpers (exported for unit tests)                                     */
/* -------------------------------------------------------------------------- */

/**
 * Classifies a watcher exit. Once a Ctrl+C has been received the run is
 * operator-terminal: graceful iff the child exited 0, otherwise a forced
 * stop — never retried. Otherwise 0/2/3/86 are terminal and any other
 * non-zero is retryable. Pure.
 */
function classifyExit(code, sigintReceived) {
  if (sigintReceived) return code === 0 ? 'terminal_graceful' : 'terminal_forced';
  if (code === 0) return 'terminal_graceful';
  if (code === 2) return 'terminal_mechanism';
  if (code === 3) return 'terminal_ownership';
  if (code === CONFIG_FAILURE_CODE) return 'terminal_config';
  return 'retryable';
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
  if (!logdir || logdir.trim() === '') return { ok: false, error: 'a log directory is required' };
  return { ok: true, date, course, logdir };
}

/**
 * The exact npm argument vector for the watcher. Passed as an argv array
 * (shell:false), so the course is never shell-interpreted. Pure.
 */
function buildWatcherArgs(date, course) {
  return ['run', 'pipeline:watch', '--', '--date', date, '--course', course, '--interval-minutes', '5', '--commit'];
}

/* -------------------------------------------------------------------------- */
/* Process orchestration                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Spawns a child, tees stdout/stderr through `onData`, and resolves with the
 * child's real numeric exit code (or 86 on a spawn error). Never detaches.
 * `spawnFn` is injectable for tests; production passes node's spawn with
 * `npm.cmd`. `onChild` receives the ChildProcess so the caller can force-kill
 * on a second Ctrl+C.
 */
function runWatcherProcess(spawnFn, command, args, onData, onChild) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    let child;
    try {
      child = spawnFn(command, args, { shell: false, stdio: ['inherit', 'pipe', 'pipe'], windowsHide: false });
    } catch (err) {
      onData(`[helper] ${command} could not be started: ${err && err.message ? err.message : String(err)}\n`);
      finish(CONFIG_FAILURE_CODE);
      return;
    }
    if (onChild) onChild(child);
    child.on('error', (err) => {
      // ENOENT etc. — npm.cmd not found / not executable.
      onData(`[helper] ${command} could not be executed (${err && err.code ? err.code : (err && err.message) || 'error'})\n`);
      finish(CONFIG_FAILURE_CODE);
    });
    if (child.stdout) child.stdout.on('data', (d) => onData(d));
    if (child.stderr) child.stderr.on('data', (d) => onData(d));
    child.on('exit', (code, signal) => {
      // A null code means the child was killed by a signal (e.g. forced stop).
      finish(code === null ? (signal ? 130 : 1) : code);
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
  const onData = (d) => {
    process.stdout.write(d);
    logAppend(d);
  };

  const args = buildWatcherArgs(date, course);
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
    emit(`[helper] pipeline:watch starting (interval 5 min, --commit)…`);
    const code = await runWatcherProcess(spawn, 'npm.cmd', args, onData, (c) => {
      currentChild = c;
    });
    currentChild = null;
    emit(`[helper] pipeline:watch exited with code ${code}`);

    const cls = classifyExit(code, sigintCount > 0);
    if (cls === 'terminal_graceful') {
      emit('[helper] TERMINAL: pipeline:watch stopped GRACEFULLY (exit 0). Not restarting — this was a deliberate stop.');
      process.exit(0);
    }
    if (cls === 'terminal_forced') {
      emit(`[helper] TERMINAL: force-stopped by operator (exit ${code}). Not restarting.`);
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
      emit('[helper] TERMINAL: npm.cmd could not be executed (config failure, exit 86). No pipeline work ran. Check the Node.js/npm installation and PATH. Not retrying.');
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
  classifyExit,
  isRetryable,
  validateArgs,
  buildWatcherArgs,
  runWatcherProcess,
  interruptibleSleep,
};

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[helper] fatal: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
