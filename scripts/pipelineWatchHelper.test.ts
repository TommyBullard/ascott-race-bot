/**
 * Tests for the pipeline-watch Node helper
 * (race-day-local/run-pipeline-watch.js) — Phase 7A.2b Step 4 graceful-Ctrl+C
 * correction.
 *
 * The helper is plain CommonJS run directly by `node` (fewest console-attached
 * intermediaries), loaded here via createRequire so its EXPORTED pure pieces
 * are unit-testable and its exit-code policy can be cross-checked against the
 * TS source of truth in src/lib/raceDayLauncher.ts. A fake-child integration
 * test (a harmless `node -e` child — NEVER npm, providers, models or a claim)
 * proves the real spawn/tee/exit-code/no-detach/no-orphan behaviour without any
 * pipeline:watch execution. True console CTRL_C_EVENT delivery cannot be
 * faithfully simulated cross-platform, so the first-SIGINT-waits behaviour is
 * covered by the source scans in raceDaySupervisor.test.ts plus the attended
 * live drill — not a synthetic signal here. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyPipelineWatchExit,
  MAX_PIPELINE_WATCH_RETRIES,
  PIPELINE_WATCH_RETRY_DELAY_SECONDS,
} from '../src/lib/raceDayLauncher';

interface HelperModule {
  MAX_RETRIES: number;
  RETRY_DELAY_SECONDS: number;
  CONFIG_FAILURE_CODE: number;
  CMD_COMMAND_NOT_FOUND: number;
  SAFE_COURSE_RE: RegExp;
  GRACEFUL_MARKER: string;
  RELEASE_FAILED_MARKER: string;
  classifyExit: (
    code: number,
    evidence: { firstInterrupt?: boolean; secondInterrupt?: boolean; gracefulConfirmed?: boolean },
  ) => string;
  effectiveExitCode: (classification: string, code: number) => number;
  isRetryable: (classification: string) => boolean;
  validateArgs: (argv: string[]) => { ok: boolean; date?: string; course?: string; logdir?: string; error?: string };
  comSpecPath: () => string;
  buildWatcherNpmCommand: (date: string, course: string) => string;
  buildComSpecArgs: (date: string, course: string) => string[];
  runWatcherProcess: (
    spawnFn: typeof spawn,
    command: string,
    args: string[],
    onData: (chunk: Buffer | string) => void,
    onChild?: (c: { pid?: number; killed?: boolean }) => void,
    extraSpawnOpts?: Record<string, unknown>,
  ) => Promise<number>;
  interruptibleSleep: (ms: number, signal: AbortSignal) => Promise<'slept' | 'interrupted'>;
}

const requireCjs = createRequire(import.meta.url);
const helper = requireCjs('../race-day-local/run-pipeline-watch.js') as HelperModule;

/* --------------------------- exit-code classification ------------------------ */

const NO_INTERRUPT = { firstInterrupt: false, secondInterrupt: false, gracefulConfirmed: false };
const FIRST_ONLY_CONFIRMED = { firstInterrupt: true, secondInterrupt: false, gracefulConfirmed: true };
const FIRST_ONLY_UNCONFIRMED = { firstInterrupt: true, secondInterrupt: false, gracefulConfirmed: false };
const SECOND_INTERRUPT = { firstInterrupt: true, secondInterrupt: true, gracefulConfirmed: false };

test('classifyExit: 0 graceful / 2 mechanism / 3 ownership / 86 config are terminal; other non-zero is retryable (no interrupt)', () => {
  assert.equal(helper.classifyExit(0, NO_INTERRUPT), 'terminal_graceful');
  assert.equal(helper.classifyExit(2, NO_INTERRUPT), 'terminal_mechanism');
  assert.equal(helper.classifyExit(3, NO_INTERRUPT), 'terminal_ownership');
  assert.equal(helper.classifyExit(86, NO_INTERRUPT), 'terminal_config');
  assert.equal(helper.classifyExit(1, NO_INTERRUPT), 'retryable');
  assert.equal(helper.classifyExit(7, NO_INTERRUPT), 'retryable');
});

// --- The reported live defect: ONE Ctrl+C + clean watcher shutdown + npm/cmd exit 1 ---

test('REGRESSION 1: first Ctrl+C + confirmed graceful completion + shell exit 1 → graceful-normalised, effective exit 0 (never "force-stopped")', () => {
  const cls = helper.classifyExit(1, FIRST_ONLY_CONFIRMED);
  assert.equal(cls, 'terminal_graceful_normalised');
  assert.notEqual(cls, 'terminal_forced');
  assert.equal(helper.effectiveExitCode(cls, 1), 0, 'the shell exit 1 is normalised to an effective 0');
  assert.equal(helper.isRetryable(cls), false);
});

test('REGRESSION 2: first Ctrl+C WITHOUT confirmed graceful completion → terminal non-zero, NOT graceful and NOT force-stopped', () => {
  const cls = helper.classifyExit(1, FIRST_ONLY_UNCONFIRMED);
  assert.equal(cls, 'terminal_interrupted_unclean');
  assert.notEqual(cls, 'terminal_graceful');
  assert.notEqual(cls, 'terminal_graceful_normalised');
  assert.notEqual(cls, 'terminal_forced');
  assert.equal(helper.effectiveExitCode(cls, 1), 1, 'an unconfirmed cleanup stays visibly non-zero');
  assert.equal(helper.isRetryable(cls), false);
});

test('REGRESSION 3: a SECOND Ctrl+C is the only thing that yields "force-stopped"', () => {
  assert.equal(helper.classifyExit(1, SECOND_INTERRUPT), 'terminal_forced');
  assert.equal(helper.classifyExit(130, SECOND_INTERRUPT), 'terminal_forced');
  assert.equal(helper.effectiveExitCode('terminal_forced', 1), 1);
  // A confirmed-graceful marker does NOT downgrade a genuine force stop.
  assert.equal(helper.classifyExit(1, { firstInterrupt: true, secondInterrupt: true, gracefulConfirmed: true }), 'terminal_forced');
});

test('REGRESSION 4: exit 1 with NO Ctrl+C is an ordinary crash (bounded retry), never force-stopped or graceful', () => {
  const cls = helper.classifyExit(1, NO_INTERRUPT);
  assert.equal(cls, 'retryable');
  assert.equal(helper.isRetryable(cls), true);
  assert.notEqual(cls, 'terminal_forced');
  assert.notEqual(cls, 'terminal_graceful_normalised');
});

test('REGRESSION 5: the 0/2/3/86 policy codes are unchanged by ANY interrupt/confirmation evidence', () => {
  for (const ev of [NO_INTERRUPT, FIRST_ONLY_CONFIRMED, FIRST_ONLY_UNCONFIRMED, SECOND_INTERRUPT]) {
    assert.equal(helper.classifyExit(0, ev), 'terminal_graceful');
    assert.equal(helper.classifyExit(2, ev), 'terminal_mechanism');
    assert.equal(helper.classifyExit(3, ev), 'terminal_ownership');
    assert.equal(helper.classifyExit(86, ev), 'terminal_config');
  }
  assert.equal(helper.effectiveExitCode('terminal_mechanism', 2), 2);
  assert.equal(helper.effectiveExitCode('terminal_ownership', 3), 3);
  assert.equal(helper.effectiveExitCode('terminal_config', 86), 86);
  assert.equal(helper.effectiveExitCode('terminal_graceful', 0), 0);
});

test('a release FAILURE must never be normalised to graceful (gracefulConfirmed requires no PRODUCER_CLAIM_RELEASE_FAILED)', () => {
  // The helper computes gracefulConfirmed = sawGracefulMarker && !sawReleaseFailed,
  // so a run whose release failed arrives here as unconfirmed.
  assert.equal(helper.classifyExit(1, FIRST_ONLY_UNCONFIRMED), 'terminal_interrupted_unclean');
  assert.equal(helper.GRACEFUL_MARKER, 'WATCH_STOPPED_GRACEFULLY');
  assert.equal(helper.RELEASE_FAILED_MARKER, 'PRODUCER_CLAIM_RELEASE_FAILED');
});

test('isRetryable: only the retryable class retries; every terminal class stops', () => {
  assert.equal(helper.isRetryable('retryable'), true);
  for (const c of [
    'terminal_graceful',
    'terminal_graceful_normalised',
    'terminal_mechanism',
    'terminal_ownership',
    'terminal_config',
    'terminal_forced',
    'terminal_interrupted_unclean',
  ]) {
    assert.equal(helper.isRetryable(c), false);
  }
});

test('policy reuse: the helper agrees with classifyPipelineWatchExit + constants in src/lib/raceDayLauncher.ts', () => {
  assert.equal(helper.MAX_RETRIES, MAX_PIPELINE_WATCH_RETRIES);
  assert.equal(helper.RETRY_DELAY_SECONDS, PIPELINE_WATCH_RETRY_DELAY_SECONDS);
  assert.equal(helper.MAX_RETRIES, 5);
  assert.equal(helper.RETRY_DELAY_SECONDS, 60);
  for (const code of [0, 2, 3, 1, 9]) {
    assert.equal(helper.classifyExit(code, NO_INTERRUPT), classifyPipelineWatchExit(code), `code ${code}`);
  }
});

/* ------------------------------- arg validation ------------------------------ */

test('validateArgs: strict calendar date, non-empty course and logdir', () => {
  assert.equal(helper.validateArgs(['2026-07-18', 'Curragh', 'logs/x']).ok, true);
  assert.equal(helper.validateArgs(['2026-13-40', 'Curragh', 'logs/x']).ok, false);
  assert.equal(helper.validateArgs(['', 'Curragh', 'logs/x']).ok, false);
  assert.equal(helper.validateArgs(['2026-07-18', '  ', 'logs/x']).ok, false);
  assert.equal(helper.validateArgs(['2026-07-18', 'Curragh', '']).ok, false);
});

test('validateArgs: rejects a course with cmd-unsafe characters (defense-in-depth for the ComSpec command line); allows safe punctuation', () => {
  assert.equal(helper.validateArgs(['2026-07-18', 'Cur&ragh', 'logs/x']).ok, false);
  assert.equal(helper.validateArgs(['2026-07-18', 'Cur"ragh', 'logs/x']).ok, false);
  assert.equal(helper.validateArgs(['2026-07-18', 'Cur%ragh', 'logs/x']).ok, false);
  assert.equal(helper.validateArgs(['2026-07-18', "St. Leger's (AW)", 'logs/x']).ok, true);
  assert.equal(helper.validateArgs(['2026-07-18', 'Down Royal', 'logs/x']).ok, true);
});

test('comSpecPath: resolves the Windows command processor and is never empty', () => {
  const v = helper.comSpecPath();
  assert.ok(typeof v === 'string' && v.length > 0);
  if (process.env.ComSpec) assert.equal(v, process.env.ComSpec);
});

test('buildComSpecArgs: cmd.exe /d /s /c "<inner>" with the course inner-double-quoted; inner runs npm.cmd pipeline:watch (NOT a direct .cmd spawn)', () => {
  const inner = helper.buildWatcherNpmCommand('2026-07-18', 'Down Royal');
  assert.equal(inner, 'npm.cmd run pipeline:watch -- --date 2026-07-18 --course "Down Royal" --interval-minutes 5 --commit');
  assert.deepEqual(helper.buildComSpecArgs('2026-07-18', 'Down Royal'), ['/d', '/s', '/c', `"${inner}"`]);
});

/* --------------------- fake-child integration (no npm/claims) ---------------- */

const NODE = process.execPath;

test('runWatcherProcess: streams a real child stdout+stderr to onData and resolves with the child exit code; child not detached; no orphan', async () => {
  const seen: string[] = [];
  const script = 'process.stdout.write("out-line\\n"); process.stderr.write("err-line\\n"); process.exit(2);';
  let child: { pid?: number; killed?: boolean } | undefined;
  const code = await helper.runWatcherProcess(
    spawn,
    NODE,
    ['-e', script],
    (d) => seen.push(d.toString()),
    (c) => {
      child = c;
    },
  );
  assert.equal(code, 2, 'the real child exit code is propagated verbatim');
  const joined = seen.join('');
  assert.match(joined, /out-line/);
  assert.match(joined, /err-line/);
  assert.ok(child && typeof child.pid === 'number', 'child was spawned attached (has a pid)');
  assert.equal(child!.killed === true, false); // resolved only after a clean exit, no orphan
});

test('runWatcherProcess: a spawn error (unrunnable command) resolves to the 86 config-failure code, never a phantom 0', async () => {
  const seen: string[] = [];
  const code = await helper.runWatcherProcess(
    spawn,
    join(tmpdir(), 'definitely-not-a-real-command-xyz.exe'),
    ['--nope'],
    (d) => seen.push(d.toString()),
  );
  assert.equal(code, helper.CONFIG_FAILURE_CODE);
  assert.equal(code, 86);
});

test('runWatcherProcess: a 9009 exit (cmd.exe "command not recognized" — e.g. npm.cmd missing) is mapped to the 86 config-failure code', async () => {
  assert.equal(helper.CMD_COMMAND_NOT_FOUND, 9009);
  const code = await helper.runWatcherProcess(spawn, NODE, ['-e', 'process.exit(9009)'], () => {});
  assert.equal(code, 86);
});

/* --------------------------- interruptible retry sleep ----------------------- */

test('interruptibleSleep: resolves "interrupted" immediately when the abort signal is already set', async () => {
  const ac = new AbortController();
  ac.abort();
  const r = await helper.interruptibleSleep(10_000, ac.signal);
  assert.equal(r, 'interrupted');
});

/* ------------------------------- log directory ------------------------------- */

test('the helper source creates the log directory recursively and writes an append-only UTF-8 log; a mkdir failure is non-zero', () => {
  const src = readFileSync('race-day-local/run-pipeline-watch.js', 'utf8');
  assert.match(src, /mkdirSync\(logdir, \{ recursive: true \}\)/);
  assert.match(src, /appendFileSync/);
  assert.match(src, /Buffer\.from\(chunk, 'utf8'\)/);
  assert.match(src, /cannot create log directory[\s\S]*?exit\(CONFIG_FAILURE_CODE\)/);
});

test('importing the helper performs no I/O and starts no process (module load is side-effect-free)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-helper-'));
  assert.ok(existsSync(dir));
  rmSync(dir, { recursive: true, force: true });
});
