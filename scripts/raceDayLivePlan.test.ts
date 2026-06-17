/**
 * Unit tests for the pure live race-day plan helpers (src/lib/raceDayLivePlan.ts)
 * and read-only / offline guards for the CLI (scripts/raceDayLivePlan.ts).
 *
 * No DB, no network, no child processes: synthetic race rows exercise the
 * schedule arithmetic, command plan, warnings, and deterministic Markdown. Source
 * scans prove the planner performs no DB writes, makes no external API call, and
 * spawns no child command. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseLivePlanArgs,
  buildRaceSchedule,
  hhmmUtc,
  buildLivePlan,
  buildLivePlanPath,
  renderLivePlanMarkdown,
  isValidIsoDate,
  NO_RACES_WARNING,
  REFRESH_OFFSET_MIN,
  CAPTURE_OFFSET_MIN,
  RESULT_CHECK_OFFSET_MIN,
  type LivePlanCommand,
  type LivePlanRaceInput,
} from '../src/lib/raceDayLivePlan';

const RACES: LivePlanRaceInput[] = [
  { id: 'r2', race_name: 'Second Race', off_time: '2026-06-16T14:05:00.000Z', course: 'Ascot' },
  { id: 'r1', race_name: 'First Race', off_time: '2026-06-16T13:30:00.000Z', course: 'Ascot' },
];

function plan(over: Partial<Parameters<typeof buildLivePlan>[0]> = {}) {
  return buildLivePlan({ date: '2026-06-16', course: 'Ascot', races: RACES, ...over });
}

function allCommands(p: ReturnType<typeof buildLivePlan>): LivePlanCommand[] {
  return [...p.preflight, ...p.perRaceCommands, ...p.endOfDay];
}

/* ------------------------------- arg parsing ------------------------------ */

test('parseLivePlanArgs: parses date, course, output', () => {
  const a = parseLivePlanArgs(['--date', '2026-06-16', '--course', 'Ascot', '--output', 'reports/x.md']);
  assert.equal(a.date, '2026-06-16');
  assert.equal(a.course, 'Ascot');
  assert.equal(a.output, 'reports/x.md');
  assert.deepEqual(a.errors, []);
  assert.deepEqual(a.requestedFutureModes, []);
});

test('parseLivePlanArgs: rejects missing / invalid dates', () => {
  assert.ok(parseLivePlanArgs(['--course', 'Ascot']).errors.length > 0);
  assert.ok(parseLivePlanArgs(['--date', '2026-13-40']).errors.some((e) => /Invalid --date/.test(e)));
  assert.ok(parseLivePlanArgs(['--date', '2026-02-30']).errors.some((e) => /Invalid --date/.test(e)));
});

test('parseLivePlanArgs: future flags are captured (for an inert warning), not activated', () => {
  const a = parseLivePlanArgs(['--date', '2026-06-16', '--operate', '--allow-writes', '--auto-results']);
  assert.deepEqual(a.requestedFutureModes, ['--operate', '--allow-writes', '--auto-results']);
  assert.deepEqual(a.errors, []);
});

test('isValidIsoDate: strict calendar validation', () => {
  assert.equal(isValidIsoDate('2026-06-16'), true);
  assert.equal(isValidIsoDate('2026-02-30'), false);
  assert.equal(isValidIsoDate('2026-6-1'), false);
});

/* ------------------------------- schedule --------------------------------- */

test('hhmmUtc: formats UTC HH:mm with a minute offset; null for missing/invalid', () => {
  assert.equal(hhmmUtc('2026-06-16T13:30:00.000Z'), '13:30');
  assert.equal(hhmmUtc('2026-06-16T13:30:00.000Z', -10), '13:20');
  assert.equal(hhmmUtc('2026-06-16T13:30:00.000Z', 30), '14:00');
  assert.equal(hhmmUtc(null), null);
  assert.equal(hhmmUtc('not-a-date'), null);
});

test('buildRaceSchedule: T-10 refresh and T-5 capture windows are correct', () => {
  const s = buildRaceSchedule({ id: 'r1', race_name: 'First', off_time: '2026-06-16T13:30:00.000Z' });
  assert.equal(s.off_hhmm, '13:30');
  assert.equal(s.refresh_hhmm, '13:20'); // off - 10
  assert.equal(s.capture_hhmm, '13:25'); // off - 5
  assert.equal(s.post_off_lock_hhmm, '13:30');
  assert.equal(s.result_check_hhmm, '14:00'); // off + 30
  assert.equal(REFRESH_OFFSET_MIN, 10);
  assert.equal(CAPTURE_OFFSET_MIN, 5);
  assert.equal(RESULT_CHECK_OFFSET_MIN, 30);
});

test('buildRaceSchedule: missing off_time -> all windows null (never fabricated)', () => {
  const s = buildRaceSchedule({ id: 'r1', race_name: 'First', off_time: null });
  assert.equal(s.off_hhmm, null);
  assert.equal(s.refresh_hhmm, null);
  assert.equal(s.capture_hhmm, null);
  assert.equal(s.result_check_hhmm, null);
});

test('buildLivePlan: races are sorted by off time ascending', () => {
  const p = plan();
  assert.deepEqual(p.races.map((r) => r.race_name), ['First Race', 'Second Race']);
});

/* ------------------------------ command plan ------------------------------ */

test('buildLivePlan: preflight includes check:env, check:db, results:auto', () => {
  const commands = plan().preflight.map((c) => c.command);
  assert.ok(commands.some((c) => c.startsWith('npm run check:env')));
  assert.ok(commands.some((c) => c.startsWith('npm run check:db')));
  assert.ok(commands.some((c) => c.startsWith('npm run results:auto -- --date 2026-06-16 --course Ascot')));
});

test('buildLivePlan: manual results fallback command is rendered (slugged, no --commit)', () => {
  const p = plan();
  assert.equal(p.manualResultsFallback, 'npm run import:results -- --file data/results-2026-06-16-ascot.csv');
  assert.equal(p.manualResultsFallback.includes('--commit'), false);
});

test('buildLivePlan: end-of-day includes report/export/tipsters/confidence/gates/ml', () => {
  const commands = plan().endOfDay.map((c) => c.command);
  assert.ok(commands.some((c) => c.startsWith('npm run report:day -- --date 2026-06-16 --course Ascot')));
  assert.ok(commands.some((c) => c.startsWith('npm run export:training-data -- --from 2026-06-16 --to 2026-06-16 --course Ascot')));
  assert.ok(commands.some((c) => c.startsWith('npm run tipsters:audit -- ')));
  assert.ok(commands.some((c) => c.startsWith('npm run confidence:audit -- ')));
  assert.ok(commands.some((c) => c.startsWith('npm run gates:audit -- ')));
  assert.ok(commands.some((c) => c.startsWith('npm run ml:evaluate -- --input data/exports/training-data-2026-06-16-to-2026-06-16-ascot.csv')));
});

test('buildLivePlan: the only --commit / write command is pipeline:day, flagged manual-approval', () => {
  const p = plan();
  const writeCommands = allCommands(p).filter((c) => c.command.includes('--commit') || c.writesDb);
  assert.equal(writeCommands.length, 1);
  assert.equal(writeCommands[0].command, 'npm run pipeline:day -- --date 2026-06-16 --course Ascot --commit');
  assert.equal(writeCommands[0].writesDb, true);
  assert.equal(writeCommands[0].requiresApproval, true);
});

test('safety: every command containing --commit requires manual approval; safe sections have none', () => {
  const p = plan();
  for (const c of allCommands(p)) {
    if (c.command.includes('--commit')) assert.equal(c.requiresApproval, true);
  }
  // preflight + end-of-day are the routinely-run sections: none may contain --commit
  for (const c of [...p.preflight, ...p.endOfDay]) {
    assert.equal(c.command.includes('--commit'), false);
  }
});

test('buildLivePlan: future modes documented; passing them adds an inert warning', () => {
  const p = plan({ requestedFutureModes: ['--operate'] });
  assert.deepEqual(p.futureModes.map((m) => m.flag), ['--operate', '--allow-writes', '--auto-results']);
  for (const m of p.futureModes) assert.match(m.description, /NOT implemented in this phase/);
  assert.ok(p.warnings.some((w) => /not implemented in this phase/.test(w)));
});

test('buildLivePlan: empty race list renders the no-races warning (never fabricated)', () => {
  const p = plan({ races: [] });
  assert.ok(p.warnings.includes(NO_RACES_WARNING));
  assert.equal(p.races.length, 0);
});

test('buildLivePlanPath: deterministic slugged path; no course -> date only', () => {
  assert.equal(buildLivePlanPath('2026-06-16', 'Ascot'), 'reports/live-plan-2026-06-16-ascot.md');
  assert.equal(buildLivePlanPath('2026-06-16', null), 'reports/live-plan-2026-06-16.md');
});

/* ------------------------------- rendering -------------------------------- */

test('renderLivePlanMarkdown: deterministic + covers all required sections', () => {
  const p = plan();
  const md = renderLivePlanMarkdown(p);
  assert.equal(md, renderLivePlanMarkdown(p)); // deterministic (no timestamps)
  for (const heading of [
    '## 1. Preflight',
    '## 2. Race discovery',
    '## 3. Per-race schedule',
    '## 4. Commands to run manually',
    '## 5. Dangerous commands (NOT run by this phase)',
    '## 6. End of day',
    '## 7. Future modes (documented, NOT active in this phase)',
    '## 8. Safety disclaimer',
  ]) {
    assert.ok(md.includes(heading), `missing heading: ${heading}`);
  }
  // schedule windows + manual fallback + write flag are surfaced
  assert.match(md, /13:20 \| 13:25 \| 13:30/); // T-10, T-5, off for the first race
  assert.ok(md.includes(p.manualResultsFallback));
  assert.match(md, /MANUAL APPROVAL — WRITES DB/);
  assert.match(md, /pipeline:day -- --date 2026-06-16 --course Ascot --commit/);
  // safety
  assert.match(md, /No auto-betting/);
  assert.match(md, /Official, weighed-in results only/);
});

test('renderLivePlanMarkdown: empty races -> warning + em-dash schedule, still deterministic', () => {
  const p = plan({ races: [] });
  const md = renderLivePlanMarkdown(p);
  assert.equal(md, renderLivePlanMarkdown(p));
  assert.ok(md.includes(NO_RACES_WARNING));
  assert.match(md, /no stored races/i);
});

/* --------------------- offline / no-DB / no-exec guards ------------------- */

test('no DB writes / no external API / no child commands: planner lib + CLI are safe', () => {
  const lib = readFileSync('src/lib/raceDayLivePlan.ts', 'utf8');
  const script = readFileSync('scripts/raceDayLivePlan.ts', 'utf8');
  for (const source of [lib, script]) {
    assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(source), false);
    assert.equal(/createRacingApiClient|BetfairClient|axios|getResults|\bfetch\s*\(/.test(source), false);
    assert.equal(/child_process|spawnSync|spawn\s*\(|execSync|\bexec\s*\(/.test(source), false);
  }
  // The pure lib does no I/O at all.
  assert.equal(/supabaseAdmin|node:fs|process\.env/.test(lib), false);
});

test('the CLI never references a --commit command string of its own / never executes', () => {
  const script = readFileSync('scripts/raceDayLivePlan.ts', 'utf8');
  // The CLI itself must not hardcode --commit or any spawning; planned --commit
  // text lives only in the pure lib data and is never executed. (Call-syntax only
  // so the descriptive words "executes"/"spawns" in comments don't false-match.)
  assert.equal(script.includes('--commit'), false);
  assert.equal(/child_process|spawnSync|\bspawn\s*\(|execSync|\bexec\s*\(/.test(script), false);
});
