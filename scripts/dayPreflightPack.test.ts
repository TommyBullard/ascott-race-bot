/**
 * Unit tests for the pure tomorrow race-day preflight pack
 * (src/lib/dayPreflightPack.ts) and read-only guards for the CLI
 * (scripts/dayPreflightPack.ts).
 *
 * No DB, no network, no child processes: the pack is built from a date + course
 * only and rendered deterministically. Source scans prove the generator performs
 * no DB writes, makes no external API call, spawns no child command, never
 * hardcodes a commit flag, and uses no betting/placement language beyond the
 * negated safety disclaimers. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parsePreflightArgs,
  isValidIsoDate,
  buildPreflightPath,
  buildDashboardUrl,
  buildPreflightPack,
  renderPreflightMarkdown,
  SAFETY_CHECKLIST,
  FRESHNESS_CHECKLIST,
  KNOWN_CAVEATS,
  OPERATOR_REMINDERS,
  type PreflightCommand,
} from '../src/lib/dayPreflightPack';

function pack(date = '2026-06-18', course: string | null = 'Ascot') {
  return buildPreflightPack({ date, course });
}

function allCommands(p: ReturnType<typeof buildPreflightPack>): PreflightCommand[] {
  return [...p.checks, ...p.operatingCommands, ...p.endOfDayCommands];
}

/* ------------------------------- arg parsing ------------------------------ */

test('parsePreflightArgs: parses date + course', () => {
  const a = parsePreflightArgs(['--date', '2026-06-18', '--course', 'Ascot']);
  assert.equal(a.date, '2026-06-18');
  assert.equal(a.course, 'Ascot');
  assert.deepEqual(a.errors, []);
});

test('parsePreflightArgs: rejects missing / invalid dates', () => {
  assert.ok(parsePreflightArgs(['--course', 'Ascot']).errors.length > 0);
  assert.ok(parsePreflightArgs(['--date', '2026-13-40']).errors.some((e) => /Invalid --date/.test(e)));
  assert.ok(parsePreflightArgs(['--date', '2026-02-30']).errors.some((e) => /Invalid --date/.test(e)));
  assert.ok(parsePreflightArgs(['--date', '18-06-2026']).errors.some((e) => /Invalid --date/.test(e)));
});

test('isValidIsoDate: strict calendar validation', () => {
  assert.equal(isValidIsoDate('2026-06-18'), true);
  assert.equal(isValidIsoDate('2026-02-30'), false);
  assert.equal(isValidIsoDate('2026-6-1'), false);
});

test('buildPreflightPath: deterministic slugged path; no course -> date only', () => {
  assert.equal(buildPreflightPath('2026-06-18', 'Ascot'), 'reports/preflight-2026-06-18-ascot.md');
  assert.equal(buildPreflightPath('2026-06-18', 'Royal Ascot'), 'reports/preflight-2026-06-18-royal-ascot.md');
  assert.equal(buildPreflightPath('2026-06-18', null), 'reports/preflight-2026-06-18.md');
});

test('buildDashboardUrl: read-only dashboard URL with date + course', () => {
  assert.equal(buildDashboardUrl('2026-06-18', 'Ascot'), 'http://localhost:3000/?date=2026-06-18&course=Ascot');
  assert.equal(buildDashboardUrl('2026-06-18', null), 'http://localhost:3000/?date=2026-06-18');
});

/* --------------------------------- pack ----------------------------------- */

test('buildPreflightPack: section 1 checks are check:env + check:db (read-only)', () => {
  const cmds = pack().checks.map((c) => c.command);
  assert.deepEqual(cmds, ['npm run check:env', 'npm run check:db']);
  assert.ok(pack().checks.every((c) => !c.writesDb && !c.requiresApproval));
});

test('buildPreflightPack: operating commands include pipeline, capture, results dry-run + commit', () => {
  const p = pack();
  const cmds = p.operatingCommands.map((c) => c.command);
  assert.ok(cmds.some((c) => c.includes('pipeline:day') && c.includes('--commit')));
  assert.ok(cmds.some((c) => c.startsWith('npm run capture:t-minus -- --date 2026-06-18 --course Ascot --minutes-before 5')));
  assert.ok(cmds.some((c) => c === 'npm run results:auto -- --date 2026-06-18 --course Ascot')); // dry-run
  assert.ok(cmds.some((c) => c.includes('results:auto') && c.includes('--commit'))); // commit step
});

test('buildPreflightPack: every commit / DB-writing command requires manual approval', () => {
  const p = pack();
  for (const c of allCommands(p)) {
    if (c.command.includes('--commit') || c.writesDb) assert.equal(c.requiresApproval, true);
  }
  // exactly two write/approval commands: pipeline refresh + results commit
  const writes = allCommands(p).filter((c) => c.writesDb || c.requiresApproval);
  assert.equal(writes.length, 2);
  // the routinely-run sections carry no commit flag
  for (const c of [...p.checks, ...p.endOfDayCommands]) {
    assert.equal(c.command.includes('--commit'), false);
  }
});

test('buildPreflightPack: end-of-day includes every reporting command (ml after export)', () => {
  const cmds = pack().endOfDayCommands.map((c) => c.command);
  for (const script of [
    'report:day', 'export:training-data', 'tipsters:audit', 'confidence:audit',
    'gates:audit', 'place:audit', 'lessons:day', 'ml:evaluate',
  ]) {
    assert.ok(cmds.some((c) => c.includes(`npm run ${script}`)), `missing end-of-day command: ${script}`);
  }
  // ml:evaluate reads the export CSV produced by export:training-data
  assert.ok(cmds.some((c) => c.includes('ml:evaluate') && c.includes('training-data-2026-06-18-to-2026-06-18-ascot.csv')));
});

test('buildPreflightPack: checklists / caveats / reminders are the exported constants', () => {
  const p = pack();
  assert.deepEqual(p.safetyChecklist, SAFETY_CHECKLIST);
  assert.deepEqual(p.freshnessChecklist, FRESHNESS_CHECKLIST);
  assert.deepEqual(p.caveats, KNOWN_CAVEATS);
  assert.deepEqual(p.operatorReminders, OPERATOR_REMINDERS);
});

/* -------------------------------- rendering ------------------------------- */

test('renderPreflightMarkdown: deterministic + covers all eight sections', () => {
  const p = pack();
  const md = renderPreflightMarkdown(p);
  assert.equal(md, renderPreflightMarkdown(p)); // deterministic (no timestamps)
  for (const heading of [
    '## 1. Environment / check commands',
    '## 2. Dashboard',
    '## 3. Required operating commands',
    '## 4. End-of-day commands',
    '## 5. Safety checklist',
    '## 6. Data freshness checklist',
    '## 7. Known caveats',
    '## 8. Operator reminders',
  ]) {
    assert.ok(md.includes(heading), `missing heading: ${heading}`);
  }
  // dashboard URL + status-API read-only note + commit step flagged
  assert.ok(md.includes('http://localhost:3000/?date=2026-06-18&course=Ascot'));
  assert.match(md, /\/api\/race-day\/status.*read-only/i);
  assert.match(md, /MANUAL \/ BACKEND APPROVAL — WRITES DB/);
  assert.match(md, /results:auto -- --date 2026-06-18 --course Ascot --commit/);
});

test('renderPreflightMarkdown: safety checklist warnings + freshness + caveats rendered', () => {
  const md = renderPreflightMarkdown(pack());
  assert.match(md, /No auto-betting/);
  assert.match(md, /No bet placement and no orders/);
  assert.match(md, /No model probability \/ staking \/ ranking/);
  assert.match(md, /final 10 minutes/);
  assert.match(md, /dry-run BEFORE any approved backend result commit/i);
  // freshness + caveats + reminder
  assert.match(md, /Odds updated/);
  assert.match(md, /free Racing API result endpoint can lag/i);
  assert.match(md, /positions but NOT SP\/BSP/);
  assert.match(md, /performance block as the source of truth/i);
});

/* --------------------- read-only / no-exec source guards ------------------ */

test('the preflight lib is pure (no imports, DB, fs, env, network, exec, engines, commit literal)', () => {
  const lib = readFileSync('src/lib/dayPreflightPack.ts', 'utf8');
  assert.equal(/^\s*import\s/m.test(lib), false); // zero imports — fully self-contained
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(lib), false);
  assert.equal(/supabaseAdmin|node:fs|process\.env/.test(lib), false);
  assert.equal(/createRacingApiClient|BetfairClient|axios|getResults|\bfetch\s*\(/.test(lib), false);
  assert.equal(/child_process|spawnSync|\bspawn\s*\(|execSync|\bexec\s*\(/.test(lib), false);
  assert.equal(/bettingEngine|modelProbabilities|kellyStake|scoreRaceRunners|runModelForRace/.test(lib), false);
  assert.equal(/placeOrder|placeBet|submitOrder|sendOrder/i.test(lib), false);
  // The literal commit flag never appears in source (it is constructed at runtime).
  assert.equal(/--commit/.test(lib), false);
});

test('the preflight CLI is read-only (no DB, no exec, no external API, no commit literal)', () => {
  const cli = readFileSync('scripts/dayPreflightPack.ts', 'utf8');
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(cli), false);
  assert.equal(/supabaseAdmin/.test(cli), false); // does not even read the DB
  assert.equal(/createRacingApiClient|BetfairClient|axios|getResults|\bfetch\s*\(/.test(cli), false);
  assert.equal(/child_process|spawnSync|\bspawn\s*\(|execSync|\bexec\s*\(/.test(cli), false);
  assert.equal(/placeOrder|placeBet|submitOrder|sendOrder|runModelForRace|kellyStake|bettingEngine/i.test(cli), false);
  assert.equal(/--commit/.test(cli), false); // CLI hardcodes no commit flag of its own
  // The only write is the Markdown report file.
  assert.match(cli, /writeFileSync/);
});
