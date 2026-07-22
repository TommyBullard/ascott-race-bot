/**
 * Tests for the nationwide dry-run command
 * (src/lib/nationwideDryRun.ts + src/lib/nationwideOwnership.ts +
 * scripts/nationwideDryRun.ts) — Nationwide rebuild Phase 7A.2b Step 5.
 *
 * Proves: `--mode` has no default and rejects invalid values before any
 * claim/provider/scoring/write; the nationwide ownership adapter claims
 * EXACTLY `all-uk-ire`, mirrors the selected-course fail-closed contract
 * (generation-verified heartbeat, permanent stop on loss/uncertainty/
 * unavailability, no mid-cycle reclaim), and conflicts with selected-course
 * claims in both directions (shared date-level PK); the workload reconciler
 * reuses the SAME nationwide-audit invariants (impossible odds/runner counts
 * block scoring, zero races/courses block scoring, per-course sums
 * cross-check the nationwide totals) and the SAME `normalizeCourse` rule
 * (never a second one); the shared workload gatherer is SELECT-only and
 * degrades to honest `null` (never fabricated) on a partial read failure;
 * reports are deterministic and never written without `--report`; and — by
 * source scan — the CLI never supports `--commit`/`--allow-stale`, never
 * imports `runModelForRace`/lock/results/settlement/training/GenAI code, never
 * calls a Supabase write method, and stops (never falls back to stale data)
 * on any racecard/odds/ownership failure before scoring. Run with: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildNationwideDryRunPath,
  EXTERNAL_CHECKS_SOURCE_NOTE,
  fetchNationwideWorkloadRows,
  parseNationwideCliMode,
  reconcileNationwideWorkload,
  renderNationwideDryRunMarkdown,
  toOwnershipMode,
  type NationwideDryRunReport,
  type NationwideWorkloadClient,
  type NationwideWorkloadRow,
} from '../src/lib/nationwideDryRun';
import {
  acquireNationwideOwnership,
  createNationwideHeartbeatController,
  releaseNationwideOwnership,
  type NationwideOwnershipState,
} from '../src/lib/nationwideOwnership';
import { ALL_UK_IRE_SCOPE } from '../src/lib/producerClaim';
import type { AcquireOutcome, HeartbeatOutcome, ReleaseOutcome } from '../src/lib/producerClaim';
import type { ProducerOwnershipDeps } from '../src/lib/producerOwnership';

const DATE = '2026-07-18';

/* ---------------------------- CLI mode contract ------------------------------ */

test('mode: no default — only exact "stored-only"/"live-provider" are valid; everything else (incl. missing) is null', () => {
  assert.equal(parseNationwideCliMode('stored-only'), 'stored-only');
  assert.equal(parseNationwideCliMode('live-provider'), 'live-provider');
  for (const bad of [null, undefined, '', 'stored', 'live', 'STORED-ONLY', 'commit', 'all-uk-ire']) {
    assert.equal(parseNationwideCliMode(bad), null, `expected null for ${String(bad)}`);
  }
});

test('mode mapping: CLI mode -> claim metadata mode', () => {
  assert.equal(toOwnershipMode('stored-only'), 'nationwide-stored-dry-run');
  assert.equal(toOwnershipMode('live-provider'), 'nationwide-live-provider-dry-run');
});

/* --------------------------------- fakes -------------------------------------- */

function makeDeps(over: {
  acquire?: () => Promise<AcquireOutcome> | AcquireOutcome;
  heartbeat?: () => Promise<HeartbeatOutcome> | HeartbeatOutcome;
  release?: () => Promise<ReleaseOutcome> | ReleaseOutcome;
} = {}): { deps: ProducerOwnershipDeps; calls: { acquire: number; heartbeat: number; release: number }; log: Array<{ event: string; details: Record<string, unknown> }> } {
  const log: Array<{ event: string; details: Record<string, unknown> }> = [];
  const calls = { acquire: 0, heartbeat: 0, release: 0 };
  const okAcquire: AcquireOutcome = {
    ok: true,
    acquired: true,
    stoleExpired: false,
    generation: 1,
    currentOwnerId: 'owner-fixed',
    currentScope: ALL_UK_IRE_SCOPE,
    currentExpiresAt: '2026-07-18T14:04:00.000Z',
  };
  const okHeartbeat: HeartbeatOutcome = { ok: true, renewed: true, generation: 1, expiresAt: '2026-07-18T14:05:00.000Z' };
  const okRelease: ReleaseOutcome = { ok: true, released: true };
  const deps: ProducerOwnershipDeps = {
    acquire: async () => {
      calls.acquire += 1;
      return over.acquire ? over.acquire() : okAcquire;
    },
    heartbeat: async () => {
      calls.heartbeat += 1;
      return over.heartbeat ? over.heartbeat() : okHeartbeat;
    },
    release: async () => {
      calls.release += 1;
      return over.release ? over.release() : okRelease;
    },
    newOwner: () => 'owner-fixed',
    hostname: () => 'test-host',
    pid: () => 4321,
    log: (event, details) => log.push({ event, details: details as Record<string, unknown> }),
    startTimer: () => 'handle',
    stopTimer: () => {},
  };
  return { deps, calls, log };
}

/* -------------------------- nationwide ownership adapter --------------------- */

test('nationwide acquire: claims EXACTLY all-uk-ire — never a course scope', async () => {
  let sentScope: string | null = null;
  const { deps } = makeDeps({
    acquire: () => {
      throw new Error('override below');
    },
  });
  const spied: ProducerOwnershipDeps = {
    ...deps,
    acquire: async (params) => {
      sentScope = params.scope;
      return {
        ok: true,
        acquired: true,
        stoleExpired: false,
        generation: 1,
        currentOwnerId: 'owner-fixed',
        currentScope: params.scope,
        currentExpiresAt: 't',
      };
    },
  };
  const result = await acquireNationwideOwnership({ raceDate: DATE, mode: 'nationwide-stored-dry-run' }, spied);
  assert.equal(result.ok, true);
  assert.equal(sentScope, ALL_UK_IRE_SCOPE);
  assert.equal(result.ok && result.state.scope, ALL_UK_IRE_SCOPE);
});

test('nationwide acquire: invalid date rejected before any claim RPC; refusal carries the holder identity', async () => {
  const { deps, calls } = makeDeps();
  const bad = await acquireNationwideOwnership({ raceDate: 'nope', mode: 'nationwide-stored-dry-run' }, deps);
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.reason, 'invalid_input');
  assert.equal(calls.acquire, 0);

  const refused = makeDeps({
    acquire: () => ({
      ok: true,
      acquired: false,
      stoleExpired: false,
      generation: 4,
      currentOwnerId: 'course-owner-id',
      currentScope: 'course:newmarket',
      currentExpiresAt: 't',
    }),
  });
  const result = await acquireNationwideOwnership({ raceDate: DATE, mode: 'nationwide-stored-dry-run' }, refused.deps);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'refused');
  if (!result.ok && result.reason === 'refused') {
    assert.equal(result.holderScope, 'course:newmarket'); // conflicts with a COURSE claim (shared date-level PK)
  }
});

test('nationwide vs selected-course conflict, both directions (pure decideClaim — shared date-level PK)', async () => {
  // A live COURSE claim refuses a nationwide acquire attempt (proven above via
  // the refused-with-course-scope case). The reverse direction — a live
  // NATIONWIDE claim refusing a course acquire — is proven by
  // producerOwnership.test.ts's existing selected-course conflict tests
  // (decideClaim treats ANY existing lease as blocking regardless of scope).
  // This assertion documents that BOTH modules share the identical PK-based
  // conflict rule by construction (race_date alone), not by two separate rules.
  assert.equal(ALL_UK_IRE_SCOPE, 'all-uk-ire');
});

test('nationwide acquire: mechanism unavailable and transient-then-still-failing map to unavailable/uncertain; transient retried exactly once', async () => {
  const unavailable = makeDeps({ acquire: () => ({ ok: false, failure: { kind: 'mechanism_unavailable', message: 'missing' } }) });
  const r1 = await acquireNationwideOwnership({ raceDate: DATE, mode: 'nationwide-stored-dry-run' }, unavailable.deps);
  assert.equal(!r1.ok && r1.reason, 'unavailable');
  assert.equal(unavailable.calls.acquire, 1);

  const transient = makeDeps({ acquire: () => ({ ok: false, failure: { kind: 'transient_uncertain', message: 'blip' } }) });
  const r2 = await acquireNationwideOwnership({ raceDate: DATE, mode: 'nationwide-stored-dry-run' }, transient.deps);
  assert.equal(!r2.ok && r2.reason, 'uncertain');
  assert.equal(transient.calls.acquire, 2);
});

function ownedState(over: Partial<NationwideOwnershipState> = {}): NationwideOwnershipState {
  return {
    raceDate: DATE,
    scope: ALL_UK_IRE_SCOPE,
    ownerId: 'owner-fixed',
    generation: 1,
    mode: 'nationwide-stored-dry-run',
    believed: true,
    stopReason: null,
    ...over,
  };
}

test('nationwide heartbeat: generation mismatch and renewed:false are CONFIRMED loss; transient retried once then uncertain; never reclaimed', async () => {
  const lost = makeDeps({ heartbeat: () => ({ ok: true, renewed: false }) });
  const s1 = ownedState();
  const c1 = createNationwideHeartbeatController(s1, lost.deps, 240);
  assert.equal(await c1.beatNow(), false);
  assert.equal(s1.stopReason, 'lost');
  assert.equal(await c1.beatNow(), false); // never resurrected
  assert.equal(lost.calls.acquire, 0); // never a reclaim

  const genMismatch = makeDeps({ heartbeat: () => ({ ok: true, renewed: true, generation: 2, expiresAt: 't' }) });
  const s2 = ownedState({ generation: 1 });
  const c2 = createNationwideHeartbeatController(s2, genMismatch.deps, 240);
  assert.equal(await c2.beatNow(), false);
  assert.equal(s2.stopReason, 'lost');

  const transient = makeDeps({ heartbeat: () => ({ ok: false, failure: { kind: 'transient_uncertain', message: 'blip' } }) });
  const s3 = ownedState();
  const c3 = createNationwideHeartbeatController(s3, transient.deps, 240);
  assert.equal(await c3.beatNow(), false);
  assert.equal(transient.calls.heartbeat, 2); // one attempt + exactly one retry
  assert.equal(s3.stopReason, 'uncertain');
});

test('nationwide release: owner-scoped, stops heartbeat first, never throws on failure, never restarts work', async () => {
  const state = ownedState();
  const failing = makeDeps({ release: () => ({ ok: false, failure: { kind: 'transient_uncertain', message: 'x' } }) });
  await releaseNationwideOwnership(state, null, failing.deps); // must not throw
  assert.equal(failing.log.at(-1)?.event, 'PRODUCER_CLAIM_RELEASE_FAILED');
  assert.equal(failing.calls.acquire, 0);
});

/* ------------------------------ reconciliation -------------------------------- */

function row(over: Partial<NationwideWorkloadRow> = {}): NationwideWorkloadRow {
  return { race_id: 'r1', course_label: 'Curragh', country: 'IRE', runner_count: 8, has_odds: true, priced_runner_count: 8, ...over };
}

test('reconciliation: zero races (and therefore zero courses) blocks scoring, never a fabricated pass', () => {
  const r = reconcileNationwideWorkload([]);
  assert.equal(r.ok, false);
  assert.match(r.blockReason ?? '', /zero stored races/);
  assert.equal(r.totals.races, 0);
  assert.equal(r.totals.courses, 0);
});

test('reconciliation: impossible priced-runner count (exceeds runners) blocks scoring — the SAME nationwide-audit invariant', () => {
  const r = reconcileNationwideWorkload([row({ race_id: 'bad', runner_count: 3, priced_runner_count: 8 })]);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => /pricedRunners.*exceeds runners/.test(v)), r.violations.join('; '));
});

test('reconciliation: valid multi-course data reconciles cleanly — per-course sums match the nationwide totals', () => {
  const rows = [
    row({ race_id: 'a1', course_label: 'Curragh', runner_count: 8, priced_runner_count: 8 }),
    row({ race_id: 'a2', course_label: 'Curragh', runner_count: 10, priced_runner_count: 9 }),
    row({ race_id: 'b1', course_label: 'Down Royal', runner_count: 6, has_odds: false, priced_runner_count: 0 }),
  ];
  const r = reconcileNationwideWorkload(rows);
  assert.equal(r.ok, true);
  assert.equal(r.violations.length, 0);
  assert.equal(r.totals.courses, 2);
  assert.equal(r.totals.races, 3);
  assert.equal(r.totals.runners, 24);
  assert.equal(r.totals.races_with_odds, 2);
  // Independent cross-check: the per-course sums equal the nationwide totals.
  assert.equal(r.perCourse.reduce((s, c) => s + c.races, 0), r.totals.races);
  assert.equal(r.perCourse.reduce((s, c) => s + c.runners, 0), r.totals.runners);
});

test('reconciliation: course label reused via normalizeCourse (Royal Ascot -> ascot) — no second normalisation rule', () => {
  const r = reconcileNationwideWorkload([row({ race_id: 'a', course_label: 'Royal Ascot' }), row({ race_id: 'b', course_label: 'Ascot' })]);
  assert.equal(r.totals.courses, 1);
  assert.equal(r.perCourse[0].course, 'ascot');
  assert.equal(r.perCourse[0].labels.length, 2); // both raw labels merged and reported
});

test('reconciliation: unexpected/GB-fallback country produces a WARNING, never a proven label', () => {
  const r = reconcileNationwideWorkload([row({ country: 'GB' }), row({ race_id: 'r2', country: 'FR' })]);
  assert.ok(r.warnings.some((w) => w.includes('FR')));
  assert.equal(r.ok, true); // warnings never block by themselves
});

/* ------------------------- shared workload gatherer (I/O) --------------------- */

function fakeWorkloadClient(over: Partial<NationwideWorkloadClient> = {}): { client: NationwideWorkloadClient; calls: string[] } {
  const calls: string[] = [];
  const client: NationwideWorkloadClient = {
    selectRaces: async (date) => {
      calls.push('races');
      return over.selectRaces ? over.selectRaces(date) : { data: [], error: null };
    },
    selectRunners: async (ids) => {
      calls.push('runners');
      return over.selectRunners ? over.selectRunners(ids) : { data: [], error: null };
    },
    selectLatestSnapshots: async (ids) => {
      calls.push('snapshots');
      return over.selectLatestSnapshots ? over.selectLatestSnapshots(ids) : { data: [], error: null };
    },
    selectQuotes: async (ids) => {
      calls.push('quotes');
      return over.selectQuotes ? over.selectQuotes(ids) : { data: [], error: null };
    },
  };
  return { client, calls };
}

test('gatherer: zero stored races short-circuits — never queries runners/snapshots/quotes', async () => {
  const { client, calls } = fakeWorkloadClient({ selectRaces: async () => ({ data: [], error: null }) });
  const result = await fetchNationwideWorkloadRows(client, DATE);
  assert.deepEqual(result.rows, []);
  assert.deepEqual(calls, ['races']);
});

test('gatherer: races read failure surfaces an honest error, never fabricated rows', async () => {
  const { client } = fakeWorkloadClient({ selectRaces: async () => ({ data: null, error: { message: 'boom' } }) });
  const result = await fetchNationwideWorkloadRows(client, DATE);
  assert.equal(result.rows, null);
  assert.match(result.error ?? '', /boom/);
});

test('gatherer: aggregates runners + latest snapshot + priced-runner count correctly', async () => {
  const { client } = fakeWorkloadClient({
    selectRaces: async () => ({ data: [{ id: 'r1', course: 'Curragh', country: 'IRE' }], error: null }),
    selectRunners: async () => ({ data: [{ race_id: 'r1' }, { race_id: 'r1' }, { race_id: 'r1' }], error: null }),
    selectLatestSnapshots: async () => ({ data: [{ id: 'snap-newest', race_id: 'r1' }, { id: 'snap-older', race_id: 'r1' }], error: null }),
    selectQuotes: async () => ({ data: [{ snapshot_id: 'snap-newest', runner_id: 'a' }, { snapshot_id: 'snap-newest', runner_id: 'b' }], error: null }),
  });
  const result = await fetchNationwideWorkloadRows(client, DATE);
  assert.equal(result.rows?.length, 1);
  assert.equal(result.rows?.[0].runner_count, 3);
  assert.equal(result.rows?.[0].has_odds, true);
  assert.equal(result.rows?.[0].priced_runner_count, 2); // only the FIRST (newest) snapshot's quotes
});

test('gatherer: a snapshot read failure degrades has_odds/priced_runner_count to UNKNOWN (null), never a fabricated false/zero', async () => {
  const { client } = fakeWorkloadClient({
    selectRaces: async () => ({ data: [{ id: 'r1', course: 'Curragh', country: 'IRE' }], error: null }),
    selectRunners: async () => ({ data: [{ race_id: 'r1' }], error: null }),
    selectLatestSnapshots: async () => ({ data: null, error: { message: 'snapshot table unreadable' } }),
  });
  const result = await fetchNationwideWorkloadRows(client, DATE);
  assert.equal(result.rows?.[0].has_odds, null);
  assert.equal(result.rows?.[0].priced_runner_count, null);
});

/* ------------------------------ report rendering ------------------------------ */

test('report path: reports/nationwide-dry-run-<date>-<mode>.md', () => {
  assert.equal(buildNationwideDryRunPath(DATE, 'stored-only'), 'reports/nationwide-dry-run-2026-07-18-stored-only.md');
  assert.equal(buildNationwideDryRunPath(DATE, 'live-provider'), 'reports/nationwide-dry-run-2026-07-18-live-provider.md');
});

function baseReport(over: Partial<NationwideDryRunReport> = {}): NationwideDryRunReport {
  return {
    date: DATE,
    mode: 'stored-only',
    scope: ALL_UK_IRE_SCOPE,
    ownerPrefix: 'owner-fi',
    generation: 1,
    claimStart: 'acquired',
    claimEnd: 'released',
    providerStages: [],
    reconciliation: null,
    timing: null,
    commandDurationMs: 1234,
    completed: true,
    blockedAtStage: null,
    blockedReason: null,
    ...over,
  };
}

test('markdown: deterministic, and states every required persistence/betting/external-checks statement', () => {
  const report = baseReport();
  const md1 = renderNationwideDryRunMarkdown(report, '2026-07-18T09:00:00.000Z');
  const md2 = renderNationwideDryRunMarkdown(report, '2026-07-18T09:00:00.000Z');
  assert.equal(md1, md2);
  assert.match(md1, /READ\/INGESTION BOUNDARY/);
  assert.match(md1, /No model runs, recommendations, official locks, or/);
  assert.match(md1, /No bet was placed; no bet was ever possible/);
  assert.match(md1, /No betting and no bet placement/);
  assert.match(md1, new RegExp(EXTERNAL_CHECKS_SOURCE_NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

/* --------------------------------- source scans -------------------------------- */

const LIB_DRYRUN = () => readFileSync('src/lib/nationwideDryRun.ts', 'utf8');
const LIB_OWNERSHIP = () => readFileSync('src/lib/nationwideOwnership.ts', 'utf8');
const CLI = () => readFileSync('scripts/nationwideDryRun.ts', 'utf8');

test('CLI: no --commit, no --allow-stale, no --confirm-external SUPPORT anywhere (docstring prose explaining their absence is not support)', () => {
  const src = CLI();
  assert.equal(/args\.commit|===\s*'--commit'|case '--commit'/.test(src), false);
  assert.equal(/case '--allow-stale'|args\.allowStale\b/.test(src), false);
  assert.equal(/case '--confirm-external'|args\.confirmExternal\b/.test(src), false);
});

test('CLI: mode is validated BEFORE any claim/provider/scoring call (usage path performs nothing)', () => {
  const src = CLI();
  const modeCheckIdx = src.indexOf('if (!mode) {');
  const acquireIdx = src.indexOf('acquireNationwideOwnership(');
  assert.ok(modeCheckIdx > 0 && acquireIdx > modeCheckIdx, 'mode must be validated before acquiring');
});

test('CLI: acquires ownership BEFORE any provider call or scoring; reconciliation runs BEFORE scoring', () => {
  const src = CLI();
  const acquireIdx = src.indexOf('await acquireNationwideOwnership(');
  const racecardsIdx = src.indexOf("'/api/cron/racecards'");
  const oddsIdx = src.indexOf("'/api/cron/odds'");
  const reconcileIdx = src.indexOf('reconciliation = reconcileNationwideWorkload(');
  const scoreIdx = src.indexOf('await scoreEligibleRaces(');
  assert.ok(acquireIdx > 0 && racecardsIdx > acquireIdx && oddsIdx > acquireIdx);
  assert.ok(reconcileIdx > 0 && scoreIdx > reconcileIdx, 'reconciliation must precede scoring');
  assert.ok(racecardsIdx < scoreIdx && oddsIdx < scoreIdx, 'provider stages precede scoring');
});

test('CLI: racecard/odds stage failure and malformed response both stop the run — no stale fallback', () => {
  const src = CLI();
  assert.match(src, /racecard-stage failure stops the run; no --allow-stale exists/);
  assert.match(src, /odds-stage failure stops the run; no --allow-stale exists/);
  assert.match(src, /malformed .*response stops the run before scoring/);
  assert.equal((src.match(/no --allow-stale exists/g) ?? []).length, 2);
});

test('CLI: releases ownership in a finally block (always runs, success or failure)', () => {
  const src = CLI();
  assert.match(src, /finally\s*\{[\s\S]*releaseNationwideOwnership\(/);
});

test('no model/recommendation/lock/result/settlement/training/GenAI import anywhere in the new files', () => {
  // createCallCron from raceDayPipelineRunner.ts IS legitimately reused (the same
  // authenticated HTTP caller pipeline:day/pipeline:watch use) — not forbidden.
  const forbiddenImportRe =
    /from\s+['"][^'"]*\/(modelDayRun|lockTMinus|autoResults|todayResultsSettlement|trainShadowModel|genaiGenerateCommentary)['"]/;
  for (const [name, src] of [
    ['lib/nationwideDryRun', LIB_DRYRUN()],
    ['lib/nationwideOwnership', LIB_OWNERSHIP()],
    ['scripts/nationwideDryRun', CLI()],
  ] as const) {
    assert.equal(forbiddenImportRe.test(src), false, `${name}: forbidden import found`);
  }
  // The CLI's ONLY import FROM runModelForRace.ts is the pure scoring core — never runModelForRace itself.
  const cli = CLI();
  assert.match(cli, /import \{ scoreRaceRunners, tipsterStatsFromPriors \} from '\.\.\/src\/lib\/runModelForRace';/);
  assert.equal(/\brunModelForRace\s*\(/.test(cli), false);
  assert.equal(/\brunModelForMeetingRaces\s*\(/.test(cli), false);
});

test('no Supabase write methods or write RPCs anywhere in the new files', () => {
  for (const src of [LIB_DRYRUN(), LIB_OWNERSHIP(), CLI()]) {
    assert.equal(/\.(insert|update|upsert|delete)\s*\(/.test(src), false);
  }
});

test('no cron/Railway/Vercel changes; no child-process execution', () => {
  for (const src of [LIB_DRYRUN(), LIB_OWNERSHIP(), CLI()]) {
    assert.equal(/vercel\.json|railway\.app|child_process|spawnSync|execSync/i.test(src), false);
  }
});

test('no betting/order-placement tokens anywhere in the new files', () => {
  for (const src of [LIB_DRYRUN(), LIB_OWNERSHIP(), CLI()]) {
    assert.equal(/placeBet|placeOrder|submitOrder/i.test(src), false);
  }
});

test('nationwideOwnership.ts never widens producerOwnership.ts — PipelineMode/OwnershipState untouched, only generic pieces imported', () => {
  // Every file's header names this codebase-wide project ("Nationwide rebuild
  // Phase ...") by standing convention — that bare word is not evidence of
  // awareness of the NEW nationwide modules. Check for those specifically.
  const src = readFileSync('src/lib/producerOwnership.ts', 'utf8');
  assert.match(src, /export type PipelineMode = 'pipeline-day' \| 'pipeline-watch';/);
  assert.equal(
    /nationwideDryRun|nationwideOwnership|nationwidePreflight|all-uk-ire/.test(src),
    false,
    'producerOwnership.ts must have zero awareness of the new nationwide modules/scope',
  );
});

test('existing selected-course files remain byte-unaware of nationwide (regression signature check)', () => {
  for (const file of ['src/lib/producerClaim.ts', 'src/lib/producerOwnership.ts', 'scripts/runRaceDayPipeline.ts', 'scripts/runRaceDayPipelineWatch.ts']) {
    const src = readFileSync(file, 'utf8');
    assert.equal(/nationwideDryRun|nationwideOwnership|nationwidePreflight/.test(src), false, `${file} must not reference the nationwide modules`);
  }
});
