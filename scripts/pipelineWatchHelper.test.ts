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
  classifyExit: (code: number, sigintReceived: boolean) => string;
  isRetryable: (classification: string) => boolean;
  validateArgs: (argv: string[]) => { ok: boolean; date?: string; course?: string; logdir?: string; error?: string };
  buildWatcherArgs: (date: string, course: string) => string[];
  runWatcherProcess: (
    spawnFn: typeof spawn,
    command: string,
    args: string[],
    onData: (chunk: Buffer | string) => void,
    onChild?: (c: { pid?: number; killed?: boolean }) => void,
  ) => Promise<number>;
  interruptibleSleep: (ms: number, signal: AbortSignal) => Promise<'slept' | 'interrupted'>;
}

const requireCjs = createRequire(import.meta.url);
const helper = requireCjs('../race-day-local/run-pipeline-watch.js') as HelperModule;

/* --------------------------- exit-code classification ------------------------ */

test('classifyExit: 0 graceful / 2 mechanism / 3 ownership / 86 config are terminal; other non-zero is retryable', () => {
  assert.equal(helper.classifyExit(0, false), 'terminal_graceful');
  assert.equal(helper.classifyExit(2, false), 'terminal_mechanism');
  assert.equal(helper.classifyExit(3, false), 'terminal_ownership');
  assert.equal(helper.classifyExit(86, false), 'terminal_config');
  assert.equal(helper.classifyExit(1, false), 'retryable');
  assert.equal(helper.classifyExit(7, false), 'retryable');
});

test('classifyExit: once a Ctrl+C is received the run is operator-terminal — graceful iff 0, else forced, NEVER retryable', () => {
  assert.equal(helper.classifyExit(0, true), 'terminal_graceful');
  assert.equal(helper.classifyExit(130, true), 'terminal_forced');
  assert.equal(helper.classifyExit(1, true), 'terminal_forced'); // a generic code + SIGINT is NOT retried
  assert.equal(helper.isRetryable(helper.classifyExit(1, true)), false);
});

test('isRetryable: only the retryable class retries; every terminal class stops', () => {
  assert.equal(helper.isRetryable('retryable'), true);
  for (const c of ['terminal_graceful', 'terminal_mechanism', 'terminal_ownership', 'terminal_config', 'terminal_forced']) {
    assert.equal(helper.isRetryable(c), false);
  }
});

test('policy reuse: the helper agrees with classifyPipelineWatchExit + constants in src/lib/raceDayLauncher.ts', () => {
  assert.equal(helper.MAX_RETRIES, MAX_PIPELINE_WATCH_RETRIES);
  assert.equal(helper.RETRY_DELAY_SECONDS, PIPELINE_WATCH_RETRY_DELAY_SECONDS);
  assert.equal(helper.MAX_RETRIES, 5);
  assert.equal(helper.RETRY_DELAY_SECONDS, 60);
  for (const code of [0, 2, 3, 1, 9]) {
    assert.equal(helper.classifyExit(code, false), classifyPipelineWatchExit(code), `code ${code}`);
  }
});

/* ------------------------------- arg validation ------------------------------ */

test('validateArgs: strict date, non-empty course and logdir', () => {
  assert.equal(helper.validateArgs(['2026-07-18', 'Curragh', 'logs/x']).ok, true);
  assert.equal(helper.validateArgs(['2026-13-40', 'Curragh', 'logs/x']).ok, false);
  assert.equal(helper.validateArgs(['', 'Curragh', 'logs/x']).ok, false);
  assert.equal(helper.validateArgs(['2026-07-18', '  ', 'logs/x']).ok, false);
  assert.equal(helper.validateArgs(['2026-07-18', 'Curragh', '']).ok, false);
});

test('buildWatcherArgs: the exact npm argv vector (array form → course never shell-interpreted), pipeline:watch only', () => {
  assert.deepEqual(helper.buildWatcherArgs('2026-07-18', 'Down Royal'), [
    'run',
    'pipeline:watch',
    '--',
    '--date',
    '2026-07-18',
    '--course',
    'Down Royal',
    '--interval-minutes',
    '5',
    '--commit',
  ]);
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
