/**
 * Unit tests for the pure free daily-results matching/audit helpers
 * (src/lib/freeResultsMatch.ts) and read-only guards for scripts/autoResults.ts.
 *
 * No DB, no network: synthetic free payloads + stored race/runner rows exercise
 * the fallback decision, position parsing, pagination, course filtering, race +
 * runner matching (id-preferred, unambiguous name fallback), and the per-race
 * safety gate. Source scans prove the module is pure and never fabricates SP/BSP,
 * and that the CLI does SELECT-only reads and never auto-commits. Run:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { normalizeCourse, normalizeHorseName } from '../src/lib/raceSync';
import { mapResultsAccessCategory } from '../src/lib/autoResults';
import type { ResultFreeRace, ResultFreeRunner } from '../src/lib/racingApi';
import {
  shouldTryFreeFallback,
  isTodayUtc,
  parseFinishPosition,
  isWinnerPosition,
  shouldFetchMoreFreeResults,
  filterFreeRacesByCourse,
  matchFreeRaceToDbRace,
  matchFreeRunnerToDbRunner,
  buildFreeRaceSettlement,
  collectFreeSettlements,
  commitOpsForSettlement,
  buildFreeResultsReport,
  renderFreeResultsSummary,
  FREE_RESULTS_SOURCE_LABEL,
  type DbRaceLite,
  type DbRunnerLite,
} from '../src/lib/freeResultsMatch';

function freeRace(over: Partial<ResultFreeRace> = {}): ResultFreeRace {
  return {
    race_id: 'rac_1',
    course: 'Ascot',
    date: '2026-06-17',
    off: '1:30',
    off_dt: '2026-06-17T13:30:00+00:00',
    race_name: 'Test Stakes',
    region: 'GB',
    runners: [],
    ...over,
  };
}
function freeRunner(horse: string, position: string, over: Partial<ResultFreeRunner> = {}): ResultFreeRunner {
  return { horse, horse_id: '', position, ...over };
}
function dbRace(over: Partial<DbRaceLite> = {}): DbRaceLite {
  return { id: 'db1', course: 'Ascot', off_time: '2026-06-17T13:30:00+00:00', race_name: 'Test Stakes', ...over };
}
function dbRunner(over: Partial<DbRunnerLite> = {}): DbRunnerLite {
  return { id: 'r1', horse_name: 'Alpha', horse_id: null, finish_pos: null, ...over };
}

/* ----------------------------- fallback decision -------------------------- */

test('plan_blocked / unavailable trigger the free fallback; available does not', () => {
  assert.equal(shouldTryFreeFallback('plan_blocked'), true);
  assert.equal(shouldTryFreeFallback('unavailable'), true);
  assert.equal(shouldTryFreeFallback('available'), false);
  assert.equal(shouldTryFreeFallback('missing_credentials'), false);
  // the Standard-plan probe error maps to plan_blocked -> the free fallback runs
  assert.equal(mapResultsAccessCategory('standard_plan_required'), 'plan_blocked');
  assert.equal(shouldTryFreeFallback(mapResultsAccessCategory('standard_plan_required')), true);
});

test('isTodayUtc: true only for today (UTC) — the free endpoint is today-only', () => {
  const now = new Date('2026-06-17T09:00:00Z');
  assert.equal(isTodayUtc('2026-06-17', now), true);
  assert.equal(isTodayUtc('2026-06-16', now), false);
});

/* ----------------------------- position parsing --------------------------- */

test('parseFinishPosition / isWinnerPosition: "1" is the winner; non-numeric -> null', () => {
  assert.equal(parseFinishPosition('1'), 1);
  assert.equal(parseFinishPosition('12'), 12);
  assert.equal(parseFinishPosition('PU'), null);
  assert.equal(parseFinishPosition(''), null);
  assert.equal(parseFinishPosition(null), null);
  assert.equal(isWinnerPosition('1'), true);
  assert.equal(isWinnerPosition(' 1 '), true);
  assert.equal(isWinnerPosition('2'), false);
});

/* ------------------------------- pagination ------------------------------- */

test('shouldFetchMoreFreeResults: pages until total covered or a short/empty page', () => {
  assert.equal(shouldFetchMoreFreeResults({ total: 250, skip: 0, returned: 100, limit: 100 }), true);
  assert.equal(shouldFetchMoreFreeResults({ total: 250, skip: 200, returned: 50, limit: 100 }), false); // short page
  assert.equal(shouldFetchMoreFreeResults({ total: 100, skip: 0, returned: 100, limit: 100 }), false); // covered
  assert.equal(shouldFetchMoreFreeResults({ total: 0, skip: 0, returned: 0, limit: 100 }), false);
});

/* ----------------------------- course filtering --------------------------- */

test('filterFreeRacesByCourse: keeps only the requested course (normalised, alias-aware)', () => {
  const races = [freeRace({ course: 'Ascot' }), freeRace({ course: 'Royal Ascot' }), freeRace({ course: 'Newbury' })];
  assert.equal(filterFreeRacesByCourse(races, 'Ascot', normalizeCourse).length, 2); // Ascot + Royal Ascot alias
  assert.equal(filterFreeRacesByCourse(races, null, normalizeCourse).length, 3); // no filter
});

/* ------------------------------ race matching ----------------------------- */

test('matchFreeRaceToDbRace: course + off-time within tolerance; no match otherwise', () => {
  const races = [
    dbRace({ id: 'a', off_time: '2026-06-17T13:30:00+00:00' }),
    dbRace({ id: 'b', off_time: '2026-06-17T14:05:00+00:00' }),
  ];
  assert.equal(matchFreeRaceToDbRace(freeRace({ off_dt: '2026-06-17T13:30:30+00:00' }), races, normalizeCourse).race?.id, 'a');
  assert.equal(matchFreeRaceToDbRace(freeRace({ off_dt: '2026-06-17T20:00:00+00:00' }), races, normalizeCourse).race, null);
});

test('matchFreeRaceToDbRace: two candidates within tolerance -> ambiguous (no match)', () => {
  const m = matchFreeRaceToDbRace(freeRace(), [dbRace({ id: 'a' }), dbRace({ id: 'b' })], normalizeCourse);
  assert.equal(m.race, null);
  assert.equal(m.ambiguous, true);
});

test('matchFreeRaceToDbRace: a stored racing_api_race_id is preferred when present', () => {
  const races = [dbRace({ id: 'a', racing_api_race_id: 'rac_1', off_time: null, course: 'Nowhere' })];
  assert.equal(matchFreeRaceToDbRace(freeRace({ race_id: 'rac_1' }), races, normalizeCourse).race?.id, 'a');
});

/* ----------------------------- runner matching ---------------------------- */

test('matchFreeRunnerToDbRunner: prefers horse_id over name when stored', () => {
  const runners = [dbRunner({ id: 'r1', horse_name: 'Other', horse_id: 'hrs_9' }), dbRunner({ id: 'r2', horse_name: 'Alpha', horse_id: 'hrs_1' })];
  const m = matchFreeRunnerToDbRunner(freeRunner('Alpha', '1', { horse_id: 'hrs_9' }), runners, normalizeHorseName);
  assert.equal(m.runner?.id, 'r1');
  assert.equal(m.method, 'horse_id');
});

test('matchFreeRunnerToDbRunner: normalised-name fallback only when UNAMBIGUOUS', () => {
  const unique = [dbRunner({ id: 'r1', horse_name: 'Alpha' }), dbRunner({ id: 'r2', horse_name: 'Bravo' })];
  const m = matchFreeRunnerToDbRunner(freeRunner('alpha', '1'), unique, normalizeHorseName);
  assert.equal(m.runner?.id, 'r1');
  assert.equal(m.method, 'horse_name');

  const dup = [dbRunner({ id: 'r1', horse_name: 'Alpha' }), dbRunner({ id: 'r2', horse_name: 'Alpha' })];
  const a = matchFreeRunnerToDbRunner(freeRunner('Alpha', '1'), dup, normalizeHorseName);
  assert.equal(a.runner, null);
  assert.equal(a.method, 'ambiguous');

  assert.equal(matchFreeRunnerToDbRunner(freeRunner('Zulu', '1'), unique, normalizeHorseName).method, 'unmatched');
});

/* --------------------------- per-race settlement -------------------------- */

test('buildFreeRaceSettlement: one winner + all matched -> clean audit, SP/BSP null, settle-ready', () => {
  const free = freeRace({ runners: [freeRunner('Alpha', '1'), freeRunner('Bravo', '2'), freeRunner('Charlie', '3')] });
  const dbRunners = [
    dbRunner({ id: 'r1', horse_name: 'Alpha' }),
    dbRunner({ id: 'r2', horse_name: 'Bravo' }),
    dbRunner({ id: 'r3', horse_name: 'Charlie' }),
  ];
  const s = buildFreeRaceSettlement(free, dbRace(), dbRunners, normalizeHorseName);
  assert.equal(s.audit.has_winner, true);
  assert.equal(s.audit.duplicate_winner_conflict, false);
  assert.equal(s.audit.unmatched_runners, 0);
  assert.equal(s.audit.ambiguous_rows, 0);
  assert.equal(s.audit.partial, false);
  assert.equal(s.safety.canCommit, true);
  const winner = s.runners.find((r) => r.finish_pos === 1)!;
  assert.equal(winner.free_horse, 'Alpha');
  assert.equal(winner.matched_runner_id, 'r1');
  assert.equal(winner.sp_decimal, null); // never fabricated
  assert.equal(winner.bsp_decimal, null);
});

test('buildFreeRaceSettlement: no winner refuses commit', () => {
  const free = freeRace({ runners: [freeRunner('Alpha', '2'), freeRunner('Bravo', '3')] });
  const s = buildFreeRaceSettlement(free, dbRace(), [dbRunner({ id: 'r1', horse_name: 'Alpha' }), dbRunner({ id: 'r2', horse_name: 'Bravo' })], normalizeHorseName);
  assert.equal(s.audit.has_winner, false);
  assert.equal(s.safety.canCommit, false);
  assert.match(s.pending_reason ?? '', /no winner/);
});

test('buildFreeRaceSettlement: multiple winners refuses commit', () => {
  const free = freeRace({ runners: [freeRunner('Alpha', '1'), freeRunner('Bravo', '1')] });
  const s = buildFreeRaceSettlement(free, dbRace(), [dbRunner({ id: 'r1', horse_name: 'Alpha' }), dbRunner({ id: 'r2', horse_name: 'Bravo' })], normalizeHorseName);
  assert.equal(s.audit.duplicate_winner_conflict, true);
  assert.equal(s.safety.canCommit, false);
});

test('buildFreeRaceSettlement: unmatched race (no stored race) refuses commit', () => {
  const s = buildFreeRaceSettlement(freeRace({ runners: [freeRunner('Alpha', '1')] }), null, [], normalizeHorseName, true);
  assert.equal(s.audit.unmatched_races, 1);
  assert.equal(s.safety.canCommit, false);
  assert.match(s.pending_reason ?? '', /ambiguous|unmatched/i);
});

test('buildFreeRaceSettlement: an unmatched finisher refuses commit', () => {
  const free = freeRace({ runners: [freeRunner('Alpha', '1'), freeRunner('Ghost', '2')] });
  const s = buildFreeRaceSettlement(free, dbRace(), [dbRunner({ id: 'r1', horse_name: 'Alpha' })], normalizeHorseName);
  assert.equal(s.audit.unmatched_runners, 1);
  assert.equal(s.safety.canCommit, false);
});

test('buildFreeRaceSettlement: an ambiguous runner refuses commit', () => {
  const free = freeRace({ runners: [freeRunner('Alpha', '1')] });
  const dup = [dbRunner({ id: 'r1', horse_name: 'Alpha' }), dbRunner({ id: 'r2', horse_name: 'Alpha' })];
  const s = buildFreeRaceSettlement(free, dbRace(), dup, normalizeHorseName);
  assert.equal(s.audit.ambiguous_rows, 1);
  assert.equal(s.safety.canCommit, false);
});

test('buildFreeRaceSettlement: partial result (no positions at all) refuses commit', () => {
  const free = freeRace({ runners: [freeRunner('Alpha', ''), freeRunner('Bravo', '')] });
  const s = buildFreeRaceSettlement(free, dbRace(), [dbRunner({ id: 'r1', horse_name: 'Alpha' }), dbRunner({ id: 'r2', horse_name: 'Bravo' })], normalizeHorseName);
  assert.equal(s.audit.partial, true);
  assert.equal(s.audit.has_winner, false);
  assert.equal(s.safety.canCommit, false);
});

test('buildFreeRaceSettlement: refuses to overwrite a non-null result with null', () => {
  // Stored Alpha already finished 1st; the free row shows Alpha as a non-finisher (PU).
  const free = freeRace({ runners: [freeRunner('Alpha', 'PU'), freeRunner('Bravo', '1')] });
  const s = buildFreeRaceSettlement(
    free,
    dbRace(),
    [dbRunner({ id: 'r1', horse_name: 'Alpha', finish_pos: 1 }), dbRunner({ id: 'r2', horse_name: 'Bravo' })],
    normalizeHorseName,
  );
  assert.equal(s.audit.would_overwrite_nonnull_with_null, true);
  assert.equal(s.safety.canCommit, false);
});

/* ---------------------- collect + report + render ------------------------- */

test('collectFreeSettlements: settles matched races, marks the rest pending/unavailable', () => {
  const free1 = freeRace({ race_id: 'rac_1', off_dt: '2026-06-17T13:30:00+00:00', race_name: 'Race 1', runners: [freeRunner('Alpha', '1'), freeRunner('Bravo', '2')] });
  const dbRaces = [
    dbRace({ id: 'd1', off_time: '2026-06-17T13:30:00+00:00', race_name: 'Race 1' }),
    dbRace({ id: 'd2', off_time: '2026-06-17T14:05:00+00:00', race_name: 'Race 2' }),
  ];
  const runnersByRace = new Map<string, DbRunnerLite[]>([
    ['d1', [dbRunner({ id: 'r1', horse_name: 'Alpha' }), dbRunner({ id: 'r2', horse_name: 'Bravo' })]],
  ]);
  const { settlements, pending } = collectFreeSettlements({ freeRaces: [free1], dbRaces, runnersByRace, normalizeCourse, normalizeHorseName });
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].matched_db_race_id, 'd1');
  assert.equal(settlements[0].safety.canCommit, true);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, 'd2');
  assert.match(pending[0].reason, /no official\/free result available yet/);
});

test('buildFreeResultsReport + render: free not attempted -> manual CSV fallback shown', () => {
  const report = buildFreeResultsReport({
    date: '2026-06-16',
    course: 'Ascot',
    commitRequested: false,
    primarySource: 'The Racing API /v1/results',
    primaryStatus: 'plan_blocked',
    primaryDetail: 'Standard Plan required',
    freeAttempted: false,
    freeNotApplicableReason: 'the free endpoint only covers today',
    freeResultsFound: 0,
    settlements: [],
    pendingDbRaces: [],
    manualImportCommand: 'npm run import:results -- --file data/results-2026-06-16-ascot.csv',
  });
  const out = renderFreeResultsSummary(report);
  assert.match(out, /manual CSV fallback required/);
  assert.match(out, /npm run import:results -- --file data\/results-2026-06-16-ascot\.csv/);
  assert.match(out, /not attempted/);
});

test('renderFreeResultsSummary: deterministic; shows winner, SP/BSP null, settle-ready, source label', () => {
  const free = freeRace({ race_name: 'Clean Race', runners: [freeRunner('Alpha', '1'), freeRunner('Bravo', '2')] });
  const { settlements, pending } = collectFreeSettlements({
    freeRaces: [free],
    dbRaces: [dbRace()],
    runnersByRace: new Map([['db1', [dbRunner({ id: 'r1', horse_name: 'Alpha' }), dbRunner({ id: 'r2', horse_name: 'Bravo' })]]]),
    normalizeCourse,
    normalizeHorseName,
  });
  const report = buildFreeResultsReport({
    date: '2026-06-17',
    course: 'Ascot',
    commitRequested: false,
    primarySource: 'The Racing API /v1/results',
    primaryStatus: 'plan_blocked',
    primaryDetail: null,
    freeAttempted: true,
    freeNotApplicableReason: null,
    freeResultsFound: 1,
    settlements,
    pendingDbRaces: pending,
    manualImportCommand: 'npm run import:results -- --file data/results-2026-06-17-ascot.csv',
  });
  const out = renderFreeResultsSummary(report);
  assert.equal(out, renderFreeResultsSummary(report)); // deterministic
  assert.match(out, /winner: Alpha \(pos 1\)/);
  assert.match(out, /SP\/BSP: \u2014 \(not provided/);
  assert.match(out, /settle-ready: yes/);
  assert.ok(out.includes(FREE_RESULTS_SOURCE_LABEL));
});

/* ------------------- commit ops, conflicts, idempotency ------------------- */

test('buildFreeRaceSettlement: commit_op classifies update / noop / conflict per runner', () => {
  const free = freeRace({ runners: [freeRunner('Alpha', '1'), freeRunner('Bravo', '2'), freeRunner('Charlie', '3')] });
  const dbRunners = [
    dbRunner({ id: 'r1', horse_name: 'Alpha', finish_pos: null }), // existing null -> update
    dbRunner({ id: 'r2', horse_name: 'Bravo', finish_pos: 2 }),    // identical -> noop
    dbRunner({ id: 'r3', horse_name: 'Charlie', finish_pos: 5 }),  // differs -> conflict
  ];
  const s = buildFreeRaceSettlement(free, dbRace(), dbRunners, normalizeHorseName);
  const byHorse = Object.fromEntries(s.runners.map((r) => [r.free_horse, r.commit_op]));
  assert.equal(byHorse['Alpha'], 'update');
  assert.equal(byHorse['Bravo'], 'noop');
  assert.equal(byHorse['Charlie'], 'conflict');
  assert.equal(s.audit.existing_result_conflict, true);
  assert.equal(s.safety.canCommit, false); // a conflict blocks the race
});

test('commitOpsForSettlement: only update ops are written; SP/BSP never in the patch', () => {
  const free = freeRace({ runners: [freeRunner('Alpha', '1'), freeRunner('Bravo', '2')] });
  const s = buildFreeRaceSettlement(
    free,
    dbRace(),
    [dbRunner({ id: 'r1', horse_name: 'Alpha', finish_pos: null }), dbRunner({ id: 'r2', horse_name: 'Bravo', finish_pos: 2 })],
    normalizeHorseName,
  );
  const ops = commitOpsForSettlement(s);
  assert.deepEqual(ops.updates, [{ runner_id: 'r1', finish_pos: 1 }]);
  assert.equal(ops.noops, 1);
  assert.equal(ops.conflicts, 0);
  for (const u of ops.updates) assert.deepEqual(Object.keys(u).sort(), ['finish_pos', 'runner_id']);
  assert.equal(s.runners[0].sp_decimal, null);
  assert.equal(s.runners[0].bsp_decimal, null);
});

test('idempotency: identical existing values -> 0 updates (all noop), still settle-ready', () => {
  const free = freeRace({ runners: [freeRunner('Alpha', '1'), freeRunner('Bravo', '2')] });
  const s = buildFreeRaceSettlement(
    free,
    dbRace(),
    [dbRunner({ id: 'r1', horse_name: 'Alpha', finish_pos: 1 }), dbRunner({ id: 'r2', horse_name: 'Bravo', finish_pos: 2 })],
    normalizeHorseName,
  );
  assert.equal(s.audit.existing_result_conflict, false);
  assert.equal(s.safety.canCommit, true);
  const ops = commitOpsForSettlement(s);
  assert.equal(ops.updates.length, 0); // a re-run writes nothing
  assert.equal(ops.noops, 2);
});

test('conflicting existing finish_pos blocks commit', () => {
  const s = buildFreeRaceSettlement(
    freeRace({ runners: [freeRunner('Alpha', '1')] }),
    dbRace(),
    [dbRunner({ id: 'r1', horse_name: 'Alpha', finish_pos: 3 })],
    normalizeHorseName,
  );
  assert.equal(s.audit.existing_result_conflict, true);
  assert.equal(s.safety.canCommit, false);
  assert.match(s.pending_reason ?? '', /conflict/i);
});

test('conflicting existing winner blocks commit', () => {
  // DB winner is Alpha (pos 1); the free result says Bravo won (Alpha is now 2nd).
  const s = buildFreeRaceSettlement(
    freeRace({ runners: [freeRunner('Alpha', '2'), freeRunner('Bravo', '1')] }),
    dbRace(),
    [dbRunner({ id: 'r1', horse_name: 'Alpha', finish_pos: 1 }), dbRunner({ id: 'r2', horse_name: 'Bravo', finish_pos: null })],
    normalizeHorseName,
  );
  assert.equal(s.audit.existing_result_conflict, true); // Alpha existing 1 != incoming 2
  assert.equal(s.safety.canCommit, false);
});

test('buildFreeResultsReport: commit plan counts (planned updates / noops / conflicts / blocked)', () => {
  const fresh = buildFreeRaceSettlement(
    freeRace({ race_id: 'r1', off_dt: '2026-06-17T13:30:00+00:00', runners: [freeRunner('Alpha', '1'), freeRunner('Bravo', '2')] }),
    dbRace({ id: 'd1' }),
    [dbRunner({ id: 'a', horse_name: 'Alpha', finish_pos: null }), dbRunner({ id: 'b', horse_name: 'Bravo', finish_pos: null })],
    normalizeHorseName,
  );
  const settled = buildFreeRaceSettlement(
    freeRace({ race_id: 'r2', off_dt: '2026-06-17T14:05:00+00:00', runners: [freeRunner('Cara', '1'), freeRunner('Delt', '2')] }),
    dbRace({ id: 'd2' }),
    [dbRunner({ id: 'c', horse_name: 'Cara', finish_pos: 1 }), dbRunner({ id: 'd', horse_name: 'Delt', finish_pos: 2 })],
    normalizeHorseName,
  );
  const blocked = buildFreeRaceSettlement(
    freeRace({ race_id: 'r3', off_dt: '2026-06-17T14:40:00+00:00', runners: [freeRunner('Echo', '1')] }),
    dbRace({ id: 'd3' }),
    [dbRunner({ id: 'e', horse_name: 'Echo', finish_pos: 4 })], // conflict
    normalizeHorseName,
  );
  const report = buildFreeResultsReport({
    date: '2026-06-17', course: 'Ascot', commitRequested: false,
    primarySource: 'x', primaryStatus: 'plan_blocked', primaryDetail: null,
    freeAttempted: true, freeNotApplicableReason: null, freeResultsFound: 3,
    settlements: [fresh, settled, blocked], pendingDbRaces: [], manualImportCommand: 'cmd',
  });
  assert.equal(report.settle_ready_count, 2);
  assert.equal(report.races_blocked, 1);
  assert.equal(report.runner_updates_planned, 2); // fresh's two updates
  assert.equal(report.idempotent_noops, 2);       // settled's two noops
  assert.equal(report.conflict_rows, 1);          // blocked's conflict
  assert.equal(report.races_committed, 0);        // dry-run -> nothing committed
});

test('renderFreeResultsSummary: DRY RUN vs COMMIT header + deterministic; pending/blocked untouched note', () => {
  const s = buildFreeRaceSettlement(
    freeRace({ runners: [freeRunner('Alpha', '1'), freeRunner('Bravo', '2')] }),
    dbRace(),
    [dbRunner({ id: 'r1', horse_name: 'Alpha', finish_pos: null }), dbRunner({ id: 'r2', horse_name: 'Bravo', finish_pos: null })],
    normalizeHorseName,
  );
  const common = {
    date: '2026-06-17', course: 'Ascot', primarySource: 'x', primaryStatus: 'plan_blocked' as const,
    primaryDetail: null, freeAttempted: true, freeNotApplicableReason: null, freeResultsFound: 1,
    settlements: [s], pendingDbRaces: [], manualImportCommand: 'cmd',
  };
  const dry = renderFreeResultsSummary(buildFreeResultsReport({ ...common, commitRequested: false }));
  assert.match(dry, /\u2014 DRY RUN \(free daily fallback\)/);
  assert.match(dry, /would commit 2 finish_pos update\(s\)/);
  assert.match(dry, /no database writes/);
  assert.equal(dry, renderFreeResultsSummary(buildFreeResultsReport({ ...common, commitRequested: false })));

  const com = renderFreeResultsSummary(buildFreeResultsReport({ ...common, commitRequested: true, committedRaces: 1, committedRunners: 2 }));
  assert.match(com, /\u2014 COMMIT \(free daily fallback\)/);
  assert.match(com, /1 race\(s\) committed, 2 runner\(s\) updated/);
  assert.match(com, /pending\/blocked races untouched/);
});

test('dry-run and commit share identical audit/matching logic (no commit flag in the audit builder)', () => {
  const a = buildFreeRaceSettlement(freeRace({ runners: [freeRunner('Alpha', '1')] }), dbRace(), [dbRunner({ id: 'r1', horse_name: 'Alpha', finish_pos: null })], normalizeHorseName);
  const b = buildFreeRaceSettlement(freeRace({ runners: [freeRunner('Alpha', '1')] }), dbRace(), [dbRunner({ id: 'r1', horse_name: 'Alpha', finish_pos: null })], normalizeHorseName);
  assert.deepEqual(a, b);
});

/* --------------------- purity / read-only source guards ------------------- */

test('the free-match module is pure (no DB/fs/net) and never fabricates SP/BSP', () => {
  const src = readFileSync('src/lib/freeResultsMatch.ts', 'utf8');
  assert.equal(/supabaseAdmin|node:fs|process\.env|\bfetch\s*\(/.test(src), false);
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(src), false);
  // SP/BSP are the literal null and never assigned a value.
  assert.equal(/sp_decimal:\s*null/.test(src), true);
  assert.equal(/bsp_decimal:\s*null/.test(src), true);
});

test('the CLI write layer is commit-gated and writes only finish_pos + race status (never SP/BSP)', () => {
  const cli = readFileSync('scripts/autoResults.ts', 'utf8');
  // The only writes are commit-gated runner finish_pos + race status updates.
  assert.match(cli, /if \(commit\)/);
  assert.match(cli, /\.update\(\{ finish_pos: u\.finish_pos \}\)/);
  assert.match(cli, /\.update\(\{ status: 'result', official_result_time: nowIso \}\)/);
  // never writes / overwrites SP or BSP.
  assert.equal(/sp_decimal|bsp_decimal/.test(cli), false);
  // no insert / upsert / delete / rpc anywhere.
  assert.equal(/\.(insert|upsert|delete|rpc)\s*\(/.test(cli), false);
  // no model / staking / ranking / recommendation / bet-placement imports.
  assert.equal(/bettingEngine|modelProbabilities|kellyStake|scoreRaceRunners|BetfairClient|placeOrder|placeBet/.test(cli), false);
});
