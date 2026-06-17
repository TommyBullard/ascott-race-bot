/**
 * Unit tests for the pure dashboard readiness assessment
 * (src/lib/dashboardReadiness.ts) and read-only guards for the CLI
 * (scripts/dashboardReadiness.ts).
 *
 * No DB, no network, no child processes: synthetic readiness inputs exercise the
 * assessment, the suggested commands, and the deterministic Markdown. Source
 * scans prove the checker performs no DB writes, makes no external API call,
 * spawns no child command, and never hardcodes a commit flag. Run with: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseReadinessArgs,
  isValidIsoDate,
  buildReadinessPath,
  buildDashboardUrl,
  assessDashboardReadiness,
  renderReadinessMarkdown,
  summarizeReadiness,
  type ReadinessInput,
} from '../src/lib/dashboardReadiness';

function input(over: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    date: '2026-06-18',
    course: 'Ascot',
    racesFound: 7,
    runnersFound: 90,
    hasOddsSnapshot: true,
    latestOddsSnapshotTime: '2026-06-18T12:00:00.000Z',
    hasModelRun: true,
    latestModelRunTime: '2026-06-18T12:05:00.000Z',
    recommendationsCount: 6,
    settledRaces: 0,
    pendingRaces: 7,
    ...over,
  };
}

/* ------------------------------- arg parsing ------------------------------ */

test('parseReadinessArgs: parses date/course/--report', () => {
  const a = parseReadinessArgs(['--date', '2026-06-18', '--course', 'Ascot', '--report']);
  assert.equal(a.date, '2026-06-18');
  assert.equal(a.course, 'Ascot');
  assert.equal(a.report, true);
  assert.deepEqual(a.errors, []);
});

test('parseReadinessArgs: report defaults false; rejects missing / invalid dates', () => {
  assert.equal(parseReadinessArgs(['--date', '2026-06-18']).report, false);
  assert.ok(parseReadinessArgs(['--course', 'Ascot']).errors.length > 0);
  assert.ok(parseReadinessArgs(['--date', '2026-13-40']).errors.some((e) => /Invalid --date/.test(e)));
});

test('isValidIsoDate: strict calendar validation', () => {
  assert.equal(isValidIsoDate('2026-06-18'), true);
  assert.equal(isValidIsoDate('2026-02-30'), false);
  assert.equal(isValidIsoDate('2026-6-1'), false);
});

test('buildReadinessPath / buildDashboardUrl: deterministic', () => {
  assert.equal(buildReadinessPath('2026-06-18', 'Ascot'), 'reports/dashboard-readiness-2026-06-18-ascot.md');
  assert.equal(buildReadinessPath('2026-06-18', null), 'reports/dashboard-readiness-2026-06-18.md');
  assert.equal(buildDashboardUrl('2026-06-18', 'Ascot'), 'http://localhost:3000/?date=2026-06-18&course=Ascot');
});

/* ------------------------------- assessment ------------------------------- */

test('no races found -> NOT READY, warns, and suggests a racecard/pipeline command', () => {
  const r = assessDashboardReadiness(
    input({ racesFound: 0, runnersFound: 0, hasOddsSnapshot: false, hasModelRun: false, recommendationsCount: 0, pendingRaces: 0 }),
  );
  assert.equal(r.level, 'not-ready');
  assert.equal(r.dashboardWillLoadUsefulData, false);
  assert.equal(r.checks.find((c) => c.key === 'races')!.status, 'missing');
  assert.ok(r.missing.includes('races'));
  assert.ok(r.suggestedCommands.some((c) => c.command.includes('pipeline:day')));
});

test('races found but no odds -> PARTIAL with an odds-missing warning', () => {
  const r = assessDashboardReadiness(
    input({ hasOddsSnapshot: false, latestOddsSnapshotTime: null }),
  );
  assert.equal(r.level, 'partial');
  assert.equal(r.checks.find((c) => c.key === 'odds')!.status, 'missing');
  assert.ok(r.missing.includes('odds snapshot'));
  assert.ok(r.suggestedCommands.some((c) => c.command.includes('pipeline:day')));
});

test('races found but no model -> PARTIAL with a model-missing warning', () => {
  const r = assessDashboardReadiness(
    input({ hasModelRun: false, latestModelRunTime: null, recommendationsCount: 0 }),
  );
  assert.equal(r.level, 'partial');
  assert.equal(r.checks.find((c) => c.key === 'model')!.status, 'missing');
  assert.ok(r.missing.includes('model run'));
  // Recommendations missing because there is no model run (not a no-bet warning).
  assert.equal(r.checks.find((c) => c.key === 'recommendations')!.status, 'missing');
});

test('recommendations present -> READY and the dashboard will load useful data', () => {
  const r = assessDashboardReadiness(input());
  assert.equal(r.level, 'ready');
  assert.equal(r.dashboardWillLoadUsefulData, true);
  assert.equal(r.checks.find((c) => c.key === 'recommendations')!.status, 'ok');
  assert.deepEqual(r.missing, []);
});

test('model ran but no recommendations -> READY with a no-bet warning (not missing)', () => {
  const r = assessDashboardReadiness(input({ recommendationsCount: 0 }));
  assert.equal(r.level, 'ready');
  assert.equal(r.checks.find((c) => c.key === 'recommendations')!.status, 'warn');
});

test('settled day -> SETTLED summary', () => {
  const r = assessDashboardReadiness(
    input({ date: '2026-06-17', settledRaces: 7, pendingRaces: 0 }),
  );
  assert.equal(r.level, 'settled');
  assert.equal(r.checks.find((c) => c.key === 'results')!.status, 'ok');
  assert.match(r.summary, /SETTLED/);
  assert.ok(r.suggestedCommands.some((c) => c.command.includes('report:day')));
});

test('partially settled day -> results check warns', () => {
  const r = assessDashboardReadiness(input({ date: '2026-06-17', settledRaces: 3, pendingRaces: 4 }));
  assert.equal(r.checks.find((c) => c.key === 'results')!.status, 'warn');
});

/* -------------------------------- rendering ------------------------------- */

test('renderReadinessMarkdown: deterministic + covers verdict/checks/missing/suggestions', () => {
  const r = assessDashboardReadiness(input({ racesFound: 0, runnersFound: 0, hasOddsSnapshot: false, hasModelRun: false, recommendationsCount: 0, pendingRaces: 0 }));
  const md = renderReadinessMarkdown(r);
  assert.equal(md, renderReadinessMarkdown(r)); // deterministic (no timestamps)
  for (const heading of ['## Verdict', '## Checks', '## Missing', '## Suggested safe commands (NOT run)', '## Dashboard']) {
    assert.ok(md.includes(heading), `missing heading: ${heading}`);
  }
  assert.match(md, /Overall: \*\*NOT-READY\*\*/);
  assert.match(md, /MANUAL \/ BACKEND APPROVAL — WRITES DB/);
  assert.ok(md.includes('http://localhost:3000/?date=2026-06-18&course=Ascot'));
});

test('summarizeReadiness: compact one-line headline + dashboard URL', () => {
  const r = assessDashboardReadiness(input());
  const line = summarizeReadiness(r);
  assert.match(line, /^\[READY\]/);
  assert.ok(line.includes('http://localhost:3000/?date=2026-06-18&course=Ascot'));
});

/* --------------------- read-only / no-exec source guards ------------------ */

test('the readiness lib is pure (no imports, DB, fs, env, network, exec, engines, commit literal)', () => {
  const lib = readFileSync('src/lib/dashboardReadiness.ts', 'utf8');
  assert.equal(/^\s*import\s/m.test(lib), false); // zero imports — fully self-contained
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(lib), false);
  assert.equal(/supabaseAdmin|node:fs|process\.env/.test(lib), false);
  assert.equal(/createRacingApiClient|BetfairClient|axios|getResults|\bfetch\s*\(/.test(lib), false);
  assert.equal(/child_process|spawnSync|\bspawn\s*\(|execSync|\bexec\s*\(/.test(lib), false);
  assert.equal(/bettingEngine|modelProbabilities|kellyStake|scoreRaceRunners|runModelForRace/.test(lib), false);
  assert.equal(/placeOrder|placeBet|submitOrder|sendOrder/i.test(lib), false);
  assert.equal(/--commit/.test(lib), false); // commit flag constructed at runtime
});

test('the readiness CLI is read-only (select-only, no writes, no exec, no external API, no commit literal)', () => {
  const cli = readFileSync('scripts/dashboardReadiness.ts', 'utf8');
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(cli), false);
  assert.equal(/createRacingApiClient|BetfairClient|axios|getResults|\bfetch\s*\(/.test(cli), false);
  assert.equal(/child_process|spawnSync|\bspawn\s*\(|execSync|\bexec\s*\(/.test(cli), false);
  assert.equal(/placeOrder|placeBet|submitOrder|sendOrder|runModelForRace|kellyStake|bettingEngine/i.test(cli), false);
  assert.equal(/--commit/.test(cli), false);
  // It reads through read-only helpers + a SELECT-only runner count.
  assert.match(cli, /fetchRaceCard/);
  assert.match(cli, /\.select\(/);
});
