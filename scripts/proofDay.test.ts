/**
 * Unit tests for the READ-ONLY race-day proof-of-update report
 * (src/lib/proofDay.ts) plus read-only source-scan guards on the pure module +
 * CLI.
 *
 * The assembly + render are pure and deterministic, so no DB / network / files
 * are needed (beyond reading the sources for the scans). These lock the task's
 * rules: the proof works whether or not the audit tables exist, renders settled
 * and pending races, degrades safely with no GenAI, writes no DB, and is
 * deterministic. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseProofArgs,
  isValidIsoDate,
  buildProofPath,
  buildCommentaryPath,
  summarizeProofCron,
  findCronJob,
  oddsFreshness,
  latestRaceTime,
  collectMissingMigrations,
  suggestOperatorActions,
  renderProofMarkdown,
  summarizeProof,
  AUDIT_MIGRATIONS,
  PROOF_STALE_ODDS_MS,
  type DayProofInput,
  type ProofRaceInput,
  type ProofCronRow,
} from '../src/lib/proofDay';

const NOW = Date.parse('2026-06-18T20:00:00Z');

function race(over: Partial<ProofRaceInput> = {}): ProofRaceInput {
  return {
    raceId: 'r1',
    offTime: '2026-06-18T14:30:00Z',
    raceName: 'Test Stakes',
    fieldSize: 12,
    latestOddsSnapshotTime: '2026-06-18T14:25:00Z',
    latestModelRunTime: '2026-06-18T14:26:00Z',
    hasModelRun: true,
    modelRunsCount: 5,
    postOffRunsIgnored: 2,
    recommendationCount: 1,
    status: 'result',
    settled: true,
    finishPosAvailable: true,
    winnerName: 'Alpha',
    ...over,
  };
}

function input(over: Partial<DayProofInput> = {}): DayProofInput {
  return {
    date: '2026-06-18',
    course: 'Ascot',
    now: NOW,
    races: [race()],
    runnersFound: 12,
    cron: {
      available: true,
      value: [
        { job: 'odds', lastRun: '2026-06-18T14:30:00Z', lastStatus: 'ok', lastOk: '2026-06-18T14:30:00Z', counts: { quotesWritten: 130 } },
        { job: 'racecards', lastRun: '2026-06-18T08:00:00Z', lastStatus: 'ok', lastOk: '2026-06-18T08:00:00Z', counts: null },
      ],
    },
    mlTraining: { available: true, value: 84 },
    genai: {
      commentaryFilePath: 'reports/genai-commentary-2026-06-18-ascot.md',
      commentaryFileExists: true,
      table: { available: true, value: 3 },
    },
    ...over,
  };
}

/* ------------------------------ args + paths ------------------------------ */

test('parseProofArgs: requires a valid --date; keeps --course', () => {
  assert.deepEqual(parseProofArgs(['--date', '2026-06-18', '--course', 'Ascot']).errors, []);
  assert.equal(parseProofArgs(['--date', '2026-06-18', '--course', 'Ascot']).course, 'Ascot');
  assert.ok(parseProofArgs([]).errors.length > 0);
  assert.ok(parseProofArgs(['--date', '2026-13-40']).errors.some((e) => /Invalid --date/.test(e)));
  assert.equal(isValidIsoDate('2026-06-18'), true);
  assert.equal(isValidIsoDate('2026-02-30'), false);
});

test('path builders are slug-stable', () => {
  assert.equal(buildProofPath('2026-06-18', 'Ascot'), 'reports/proof-day-2026-06-18-ascot.md');
  assert.equal(buildProofPath('2026-06-18', null), 'reports/proof-day-2026-06-18.md');
  assert.equal(buildCommentaryPath('2026-06-18', 'Royal Ascot'), 'reports/genai-commentary-2026-06-18-royal-ascot.md');
});

/* ------------------------------- cron reduce ------------------------------ */

test('summarizeProofCron: newest run wins; counts come from the latest OK run; sorted; bad ts ignored', () => {
  const rows: ProofCronRow[] = [
    { job: 'odds', finished_at: '2026-06-18T14:00:00Z', ok: true, counts: { quotesWritten: 100 } },
    { job: 'odds', finished_at: '2026-06-18T14:30:00Z', ok: true, counts: { quotesWritten: 130 } },
    { job: 'odds', finished_at: '2026-06-18T14:45:00Z', ok: false, counts: null },
    { job: 'model', finished_at: '2026-06-18T14:20:00Z', ok: true, counts: null },
    { job: 'model', finished_at: null, ok: true, counts: null }, // ignored (no ts)
  ];
  const jobs = summarizeProofCron(rows);
  assert.deepEqual(jobs.map((j) => j.job), ['model', 'odds']); // sorted by name
  const odds = findCronJob(jobs, 'odds');
  assert.equal(odds?.lastRun, '2026-06-18T14:45:00Z');
  assert.equal(odds?.lastStatus, 'failed');
  assert.equal(odds?.lastOk, '2026-06-18T14:30:00Z');
  assert.deepEqual(odds?.counts, { quotesWritten: 130 });
});

/* ------------------------------- freshness -------------------------------- */

test('oddsFreshness: fresh / stale / unknown with the boundary inclusive of fresh', () => {
  const snap = '2026-06-18T14:00:00Z';
  const base = Date.parse(snap);
  assert.equal(oddsFreshness(snap, base + 60_000).status, 'fresh');
  assert.equal(oddsFreshness(snap, base + PROOF_STALE_ODDS_MS).status, 'fresh'); // boundary
  assert.equal(oddsFreshness(snap, base + PROOF_STALE_ODDS_MS + 1).status, 'stale');
  assert.equal(oddsFreshness(null, base).status, 'unknown');
});

test('latestRaceTime returns the newest non-null time', () => {
  const races = [race({ latestModelRunTime: '2026-06-18T14:00:00Z' }), race({ raceId: 'r2', latestModelRunTime: '2026-06-18T15:00:00Z' })];
  assert.equal(latestRaceTime(races, (r) => r.latestModelRunTime), '2026-06-18T15:00:00Z');
  assert.equal(latestRaceTime([race({ latestOddsSnapshotTime: null })], (r) => r.latestOddsSnapshotTime), null);
});

/* ------------------------ audit tables present / missing ------------------ */

test('works when audit tables EXIST: counts + sync proof render', () => {
  const md = renderProofMarkdown(input());
  assert.match(md, /ml_training_examples rows \(this meeting\): 84/);
  assert.match(md, /Stored commentary rows: 3/);
  assert.match(md, /Quotes written \(last odds run\): 130/);
  assert.match(md, /Latest racecard sync: 2026-06-18T08:00:00Z/);
  assert.equal(collectMissingMigrations(input()).length, 0);
  assert.equal(/## Missing audit migrations/.test(md), false);
});

test('works when audit tables are MISSING: graceful degradation + migration names', () => {
  const missingInput = input({
    cron: { available: false, value: [] },
    mlTraining: { available: false, value: null },
    genai: {
      commentaryFilePath: 'reports/genai-commentary-2026-06-18-ascot.md',
      commentaryFileExists: false,
      table: { available: false, value: null },
    },
  });
  const md = renderProofMarkdown(missingInput);
  assert.match(md, /cron_runs MISSING/);
  assert.match(md, /cron_runs table missing/);
  assert.match(md, /table missing \(migration needed\)/);
  assert.match(md, /## Missing audit migrations/);
  // Each missing table names its migration file.
  for (const file of Object.values(AUDIT_MIGRATIONS)) {
    assert.ok(md.includes(file), file);
  }
  const missing = collectMissingMigrations(missingInput);
  assert.equal(missing.length, 3);
});

/* --------------------------- settled / pending ---------------------------- */

test('settled race proof renders (status, finish_pos, winner)', () => {
  const md = renderProofMarkdown(input({ races: [race()] }));
  assert.match(md, /status result, finish_pos available, winner Alpha/);
  assert.match(md, /settlement settled/);
  assert.match(md, /Settled races: 1 \/ 1/);
});

test('pending race proof renders (past off, not settled)', () => {
  const pending = race({ status: null, settled: false, finishPosAvailable: false, winnerName: null });
  const md = renderProofMarkdown(input({ races: [pending] }));
  assert.match(md, /settlement pending \(not yet settled\)/);
  assert.match(md, /finish_pos none/);
});

test('upcoming race (off in the future) renders as upcoming', () => {
  const upcoming = race({ offTime: '2026-06-18T23:30:00Z', status: null, settled: false, finishPosAvailable: false, winnerName: null });
  const md = renderProofMarkdown(input({ races: [upcoming] }));
  assert.match(md, /settlement upcoming/);
});

/* ----------------------------- missing GenAI ------------------------------ */

test('missing GenAI renders safely (no commentary file, no table)', () => {
  const md = renderProofMarkdown(
    input({
      genai: {
        commentaryFilePath: 'reports/genai-commentary-2026-06-18-ascot.md',
        commentaryFileExists: false,
        table: { available: false, value: null },
      },
    }),
  );
  assert.match(md, /Commentary file: reports\/genai-commentary-2026-06-18-ascot\.md \(not generated\)/);
  assert.match(md, /Shadow-only: yes/);
  // A missing commentary file produces a genai:commentary suggestion.
  assert.ok(suggestOperatorActions(input({ genai: { commentaryFilePath: 'x.md', commentaryFileExists: false, table: { available: false, value: null } } })).some((c) => /genai:commentary/.test(c)));
});

/* ------------------------------ structure --------------------------------- */

test('renders all nine numbered sections + safety disclaimers', () => {
  const md = renderProofMarkdown(input());
  for (const heading of [
    '## 1. Racecard load proof',
    '## 2. Odds proof',
    '## 3. Model proof',
    '## 4. Pre-off proof',
    '## 5. Results proof',
    '## 6. Training capture proof',
    '## 7. GenAI proof',
    '## 8. Operator actions',
    '## 9. Safety',
  ]) {
    assert.ok(md.includes(heading), heading);
  }
  assert.match(md, /No auto-betting and no bet placement/);
  assert.match(md, /No UI writes/);
  assert.match(md, /No guarantee/);
  assert.match(md, /No model, recommendation, ranking, or staking logic is changed/);
});

test('operator actions are read-only (no commit flag) and summarizeProof is concise', () => {
  const actions = suggestOperatorActions(input());
  assert.equal(actions.some((c) => /--commit/.test(c)), false);
  assert.ok(actions.some((c) => /dashboard:ready/.test(c)));
  assert.match(summarizeProof(input()), /\[PROOF\] Ascot 2026-06-18: 1 race\(s\), 1 settled/);
});

/* ------------------------------ deterministic ----------------------------- */

test('renderProofMarkdown is deterministic for the same input', () => {
  const a = renderProofMarkdown(input());
  const b = renderProofMarkdown(input());
  assert.equal(a, b);
});

test('races are rendered in off-time order regardless of input order', () => {
  const later = race({ raceId: 'r1', offTime: '2026-06-18T15:30:00Z', raceName: 'Zulu Stakes' });
  const earlier = race({ raceId: 'r2', offTime: '2026-06-18T13:30:00Z', raceName: 'Bravo Stakes' });
  const md = renderProofMarkdown(input({ races: [later, earlier] }));
  assert.ok(md.indexOf('Bravo Stakes') < md.indexOf('Zulu Stakes'));
});

/* --------------------- read-only guards (source scans) -------------------- */

test('the proof module is pure: no DB, fs, env, network, engines, or placement', () => {
  const lib = readFileSync('src/lib/proofDay.ts', 'utf8');
  assert.equal(/supabaseAdmin/.test(lib), false);
  assert.equal(/node:fs|require\(['"]fs/.test(lib), false);
  assert.equal(/process\.env/.test(lib), false);
  assert.equal(/\bfetch\s*\(/.test(lib), false);
  assert.equal(/bettingEngine|modelProbabilities|kellyStake|scoreRaceRunners|runModelForRace/.test(lib), false);
  assert.equal(/placeOrder|placeBet|submitOrder|sendOrder/.test(lib), false);
  assert.equal(/--commit/.test(lib), false);
});

test('the proof CLI is read-only: SELECT-only, no DB writes, no commit flag, no placement', () => {
  const cli = readFileSync('scripts/proofDay.ts', 'utf8');
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(cli), false);
  assert.equal(/--commit/.test(cli), false);
  assert.equal(/placeOrder|placeBet|submitOrder|sendOrder/.test(cli), false);
  assert.equal(/runModelForRace|scoreRaceRunners/.test(cli), false);
  // Reads stored state + writes only a local report.
  assert.match(cli, /supabaseAdmin/);
  assert.match(cli, /\.select\(/);
  assert.match(cli, /from 'node:fs'/);
});
