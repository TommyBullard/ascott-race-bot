/**
 * Unit tests for the read-only operator "next action" helper
 * (src/lib/operatorNextAction.ts) plus read-only source-scan guards.
 *
 * Pure + deterministic given an injected `now`, so no DB / network is needed.
 * The scans lock down the task's rules: the widget is read-only, never writes the
 * DB, never calls an external API, never exposes `--commit`, never places a bet,
 * and never executes a command. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  deriveNextAction,
  buildScopedCommand,
  type NextAction,
} from '../src/lib/operatorNextAction';

/** Fixed clock so windowed derivations are deterministic. */
const NOW = Date.parse('2026-06-17T14:00:00Z');
function offIso(minsFromNow: number): string {
  return new Date(NOW + minsFromNow * 60_000).toISOString();
}
function race(off: string | null, status?: string | null) {
  return { off_time: off, status: status ?? null };
}

const SCOPE = { date: '2026-06-17', course: 'Ascot' };

/* ------------------------------ state-driven ------------------------------ */

test('before T-minus-10 -> monitor (no command)', () => {
  const a = deriveNextAction([race(offIso(30))], NOW, SCOPE);
  assert.equal(a.kind, 'monitor');
  assert.match(a.headline, /Next race in 30m/);
  assert.match(a.headline, /monitoring/i);
  assert.equal(a.suggestedCommand, null);
});

test('inside T-minus-10 -> refresh pipeline', () => {
  const a = deriveNextAction([race(offIso(8))], NOW, SCOPE);
  assert.equal(a.kind, 'refresh');
  assert.match(a.headline, /Next race in 8m/);
  assert.match(a.headline, /T-minus-7/);
  assert.equal(a.suggestedCommand, 'npm run pipeline:day -- --date 2026-06-17 --course Ascot');
});

test('inside T-minus-5 -> capture', () => {
  const a = deriveNextAction([race(offIso(3))], NOW, SCOPE);
  assert.equal(a.kind, 'capture');
  assert.match(a.headline, /Next race in 3m/);
  assert.match(a.headline, /capture/i);
  assert.equal(a.suggestedCommand, 'npm run capture:t-minus -- --date 2026-06-17 --course Ascot');
});

test('a race currently off -> do not rerun the model', () => {
  const a = deriveNextAction([race(offIso(-1))], NOW, SCOPE);
  assert.equal(a.kind, 'race-off');
  assert.match(a.headline, /Race off/);
  assert.match(a.headline, /do not rerun/i);
  assert.equal(a.suggestedCommand, null);
});

test('a finished race awaiting a result -> results:auto', () => {
  const a = deriveNextAction([race(offIso(-10))], NOW, SCOPE);
  assert.equal(a.kind, 'result-pending');
  assert.match(a.headline, /Result pending/);
  assert.equal(a.suggestedCommand, 'npm run results:auto -- --date 2026-06-17 --course Ascot');
  // mentions backend settling without ever showing --commit
  assert.match(a.detail, /manual backend command/i);
});

test('a single settled race -> all-settled (end-of-day reports)', () => {
  const a = deriveNextAction([race(offIso(-30), 'result')], NOW, SCOPE);
  assert.equal(a.kind, 'all-settled');
  assert.match(a.headline, /All races settled/);
  assert.equal(a.suggestedCommand, 'npm run report:day -- --date 2026-06-17 --course Ascot');
});

test('all races settled -> all-settled', () => {
  const a = deriveNextAction(
    [race(offIso(-90), 'result'), race(offIso(-60), 'result'), race(offIso(-30), 'result')],
    NOW,
    SCOPE,
  );
  assert.equal(a.kind, 'all-settled');
});

test('no races / unknown off times -> none', () => {
  assert.equal(deriveNextAction([], NOW, SCOPE).kind, 'none');
  assert.equal(deriveNextAction([race(null), race('bad')], NOW, SCOPE).kind, 'none');
});

/* ------------------------------- priority --------------------------------- */

test('priority: an imminent T-5 race outranks a pending result', () => {
  const a = deriveNextAction([race(offIso(3)), race(offIso(-10))], NOW, SCOPE);
  assert.equal(a.kind, 'capture');
});

test('priority: a pending result outranks a race that is merely off', () => {
  const a = deriveNextAction([race(offIso(-10)), race(offIso(-1))], NOW, SCOPE);
  assert.equal(a.kind, 'result-pending');
});

test('priority: an upcoming race coexisting with settled races -> monitor', () => {
  const a = deriveNextAction([race(offIso(-30), 'result'), race(offIso(40))], NOW, SCOPE);
  assert.equal(a.kind, 'monitor');
});

/* ---------------------------- command building ---------------------------- */

test('buildScopedCommand never emits --commit and quotes multi-word courses', () => {
  assert.equal(buildScopedCommand('report:day'), 'npm run report:day');
  assert.equal(buildScopedCommand('report:day', { date: '2026-06-17' }), 'npm run report:day -- --date 2026-06-17');
  assert.equal(
    buildScopedCommand('pipeline:day', { date: '2026-06-17', course: 'Royal Ascot' }),
    'npm run pipeline:day -- --date 2026-06-17 --course "Royal Ascot"',
  );
});

test('no derived action ever suggests a --commit command', () => {
  const inputs: Array<ReturnType<typeof race>[]> = [
    [race(offIso(3))],
    [race(offIso(8))],
    [race(offIso(30))],
    [race(offIso(-1))],
    [race(offIso(-10))],
    [race(offIso(-30), 'result')],
    [],
  ];
  for (const races of inputs) {
    const a: NextAction = deriveNextAction(races, NOW, SCOPE);
    if (a.suggestedCommand) {
      assert.equal(/--commit/.test(a.suggestedCommand), false, a.kind);
    }
  }
});

/* ------------------------------ determinism ------------------------------- */

test('deriveNextAction is deterministic for identical inputs', () => {
  const races = [race(offIso(8)), race(offIso(-30), 'result')];
  assert.deepEqual(deriveNextAction(races, NOW, SCOPE), deriveNextAction(races, NOW, SCOPE));
});

/* --------------------- read-only guards (source scans) -------------------- */

test('the next-action module is pure with no betting / commit / IO', () => {
  const lib = readFileSync('src/lib/operatorNextAction.ts', 'utf8');
  assert.equal(/supabaseAdmin/.test(lib), false);
  assert.equal(/node:fs/.test(lib), false);
  assert.equal(/process\.env/.test(lib), false);
  assert.equal(/\bfetch\s*\(/.test(lib), false);
  assert.equal(/--commit/.test(lib), false);
  assert.equal(/placeOrder|placeBet|submitOrder|auto-?bet|bet placement/i.test(lib), false);
});

test('the dashboard renders the next-action widget as read-only text (no write control)', () => {
  const page = readFileSync('src/app/page.tsx', 'utf8');
  assert.match(page, /deriveNextAction/);
  assert.match(page, /NextActionWidget/);
  // The command is shown as a <code> block, never executed nor a --commit control.
  assert.match(page, /<code style=\{styles\.nextActionCmd\}>/);
  assert.equal(/--commit/.test(page), false);
  assert.equal(/placeOrder|placeBet|submitOrder/i.test(page), false);
});
