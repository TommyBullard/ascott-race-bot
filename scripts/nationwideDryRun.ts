/**
 * CLI: nationwide dry-run — Nationwide rebuild Phase 7A.2b Step 5.
 *
 * The first nationwide (`all-uk-ire`) evidence command that holds a real
 * ownership claim. It NEVER persists a model run, recommendation, official
 * lock, or result — it only proves that fresh provider ingestion (live-
 * provider mode) or already-stored data (stored-only mode), followed by
 * all-course in-memory scoring, can be done safely and honestly under one
 * nationwide producer claim.
 *
 * Usage:
 *   npm run nationwide:dry-run -- --date 2026-07-18 --mode stored-only
 *   npm run nationwide:dry-run -- --date 2026-07-18 --mode live-provider [--base-url URL] [--report]
 *
 * `--mode` is REQUIRED — there is no default (Correction 1). Missing or
 * invalid `--mode` prints usage and performs NO claim, NO provider call, NO
 * scoring, and NO database write of any kind; exit 1.
 *
 * stored-only: acquires the `all-uk-ire` claim, reads ALREADY-STORED
 * nationwide data, scores every eligible race IN MEMORY, and writes NOTHING
 * to the database beyond the claim lifecycle itself (acquire/heartbeat/
 * release). No provider call is ever made in this mode.
 *
 * live-provider: acquires the claim, then calls the EXISTING authenticated
 * racecard and odds cron routes (the same routes `pipeline:day`/
 * `pipeline:watch` use) — this WILL write operational provider data (races,
 * runners, market_snapshots, runner_quotes) plus the unavoidable `cron_runs`
 * telemetry row per call. It then reconciles the stored workload and scores
 * every eligible race IN MEMORY. It NEVER persists model output. A racecard
 * or odds stage FAILURE, a malformed provider response, or a reconciliation
 * violation STOPS THE RUN before scoring — there is no `--allow-stale`
 * fallback and no mid-run reclaim (Correction 3).
 *
 * The operator SHOULD obtain a genuine READY from `nationwide:preflight`
 * before running `--mode live-provider` — see
 * docs/NATIONWIDE_DRY_RUN_PROCEDURE.md. This command does not check, invoke,
 * or fabricate that preflight result itself, and it never accepts a
 * `--confirm-external` flag (that concept belongs to the preflight only).
 *
 * NEVER: creates model_runs / model_runner_scores / recommendations /
 * locked_race_decisions / result rows / training rows / GenAI artifacts;
 * calls lock:t-minus or results:auto; starts a supervisor; adds cron; touches
 * Railway/Vercel; supports `--commit`; places a bet.
 *
 * Exit codes: 0 completed; 1 usage / invalid mode / provider or reconciliation
 * stoppage; 2 ownership mechanism unavailable/uncertain; 3 ownership refused
 * or lost. Decision-support only — never places a bet.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { buildUrl, dayParamForDate, type CronStepStatus } from '../src/lib/raceDayPipeline';
import { createCallCron } from '../src/lib/raceDayPipelineRunner';
import { normalizeCourse } from '../src/lib/raceSync';
import { fetchRaceModelInputs, fetchTipsterSelections, getTipsterStats } from '../src/lib/raceData';
import { scoreRaceRunners, tipsterStatsFromPriors } from '../src/lib/runModelForRace';
import { PRODUCER_CLAIM_DEFAULT_TTL_SECONDS } from '../src/lib/producerClaim';
import {
  acquireNationwideOwnership,
  createNationwideHeartbeatController,
  defaultProducerOwnershipDeps,
  describeAcquireFailure,
  describeStopReason,
  releaseNationwideOwnership,
  type NationwideOwnershipState,
} from '../src/lib/nationwideOwnership';
import {
  buildNationwideDryRunPath,
  buildNationwideTimingReport,
  fetchNationwideWorkloadRows,
  parseNationwideCliMode,
  reconcileNationwideWorkload,
  renderNationwideDryRunMarkdown,
  toOwnershipMode,
  type NationwideCliMode,
  type NationwideDryRunReport,
  type NationwideTimingRaceInput,
  type NationwideWorkloadClient,
  type NationwideWorkloadRow,
  type ProviderStageSummary,
} from '../src/lib/nationwideDryRun';

/** Fixed synthetic bankroll for scoring only — never persisted, matches the timing harness. */
const DRY_RUN_BANKROLL = 1000;
const DEFAULT_BASE_URL = 'http://localhost:3000';

function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      // Not present; try the next, then fall back to shell env.
    }
  }
}

interface Args {
  date: string | null;
  mode: string | null;
  baseUrl: string;
  report: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { date: null, mode: null, baseUrl: DEFAULT_BASE_URL, report: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    switch (flag) {
      case '--date':
        args.date = (next() ?? '').trim();
        break;
      case '--mode':
        args.mode = (next() ?? '').trim();
        break;
      case '--base-url': {
        const value = (next() ?? '').trim();
        if (value !== '') args.baseUrl = value;
        break;
      }
      case '--report':
        args.report = true;
        break;
      default:
        break;
    }
  }
  return args;
}

function usage(): void {
  console.error(
    [
      'Usage: npm run nationwide:dry-run -- --date YYYY-MM-DD --mode stored-only|live-provider [--base-url URL] [--report]',
      '',
      '  stored-only    reads ALREADY-STORED nationwide data; makes NO provider calls.',
      '  live-provider  refreshes racecards + odds (WRITES operational provider data),',
      '                 then scores in memory. No model/recommendation output is ever persisted.',
      '',
      '--mode is REQUIRED — there is no default. There is no --commit flag and no',
      '--allow-stale flag. Obtain a genuine READY from nationwide:preflight before',
      '--mode live-provider.',
    ].join('\n'),
  );
}

/** Reads + scores ONE race in memory (never writes). Mirrors the Phase 7A.2a timing harness exactly. */
async function scoreOneRaceInMemory(raceId: string): Promise<{ durationMs: number; runnerCount: number } | null> {
  const started = performance.now();
  const inputs = await fetchRaceModelInputs(raceId);
  if (!inputs || inputs.runners.length === 0) return null;
  const [selections, priors] = await Promise.all([fetchTipsterSelections(raceId), getTipsterStats()]);
  const stats = tipsterStatsFromPriors(priors);
  scoreRaceRunners(inputs, selections, stats, DRY_RUN_BANKROLL); // pure, in-memory, no write
  return { durationMs: performance.now() - started, runnerCount: inputs.runners.length };
}

/** The real, Supabase-backed workload client (injectable in tests). */
function createSupabaseWorkloadClient(): NationwideWorkloadClient {
  return {
    async selectRaces(date) {
      const { supabaseAdmin } = await import('../src/lib/supabaseAdmin');
      const { data, error } = await supabaseAdmin
        .from('races')
        .select('id, course, country')
        .eq('meeting_date', date);
      return { data, error };
    },
    async selectRunners(raceIds) {
      const { supabaseAdmin } = await import('../src/lib/supabaseAdmin');
      const { data, error } = await supabaseAdmin.from('runners').select('id, race_id').in('race_id', raceIds);
      return { data, error };
    },
    async selectLatestSnapshots(raceIds) {
      const { supabaseAdmin } = await import('../src/lib/supabaseAdmin');
      const { data, error } = await supabaseAdmin
        .from('market_snapshots')
        .select('id, race_id')
        .in('race_id', raceIds)
        .order('snapshot_time', { ascending: false });
      return { data, error };
    },
    async selectQuotes(snapshotIds) {
      const { supabaseAdmin } = await import('../src/lib/supabaseAdmin');
      const { data, error } = await supabaseAdmin
        .from('runner_quotes')
        .select('snapshot_id, runner_id')
        .in('snapshot_id', snapshotIds);
      return { data, error };
    },
  };
}

/** Scores every workload row, grouped by course, verifying ownership between each course. Never writes. */
async function scoreEligibleRaces(
  rows: readonly NationwideWorkloadRow[],
  state: NationwideOwnershipState,
  beatNow: () => Promise<boolean>,
): Promise<{ inputs: NationwideTimingRaceInput[]; stoppedEarly: boolean }> {
  const byCourse = new Map<string, NationwideWorkloadRow[]>();
  for (const r of rows) {
    const key = r.course_label ? normalizeCourse(r.course_label) : '(unknown course)';
    if (!byCourse.has(key)) byCourse.set(key, []);
    byCourse.get(key)!.push(r);
  }
  const courses = [...byCourse.keys()].sort();

  const inputs: NationwideTimingRaceInput[] = [];
  let stoppedEarly = false;
  for (const course of courses) {
    if (!state.believed) {
      stoppedEarly = true;
      break;
    }
    for (const row of byCourse.get(course)!) {
      const base = { race_id: row.race_id, course_label: row.course_label, off_time: null, status: null };
      try {
        const result = await scoreOneRaceInMemory(row.race_id);
        inputs.push(
          result === null
            ? { ...base, runner_count: 0, duration_ms: null, scored: false, skip_reason: 'NO_PRICED_FIELD', error: null }
            : { ...base, runner_count: result.runnerCount, duration_ms: result.durationMs, scored: true, skip_reason: null, error: null },
        );
      } catch (err) {
        inputs.push({
          ...base,
          runner_count: 0,
          duration_ms: null,
          scored: false,
          skip_reason: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Check ownership BETWEEN course batches — confirmed loss stops immediately.
    await beatNow();
    if (!state.believed) {
      stoppedEarly = true;
      break;
    }
  }
  return { inputs, stoppedEarly };
}

async function main(): Promise<void> {
  const startedAt = performance.now();
  const args = parseArgs(process.argv.slice(2));

  const mode: NationwideCliMode | null = parseNationwideCliMode(args.mode);
  if (!mode) {
    usage();
    process.exitCode = 1;
    return; // NO claim, NO provider call, NO scoring, NO write.
  }
  if (!args.date) {
    usage();
    process.exitCode = 1;
    return;
  }

  loadEnv();
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local (or .env).');
    process.exitCode = 1;
    return;
  }
  if (mode === 'live-provider' && !process.env.CRON_SECRET) {
    console.error('Missing CRON_SECRET in .env.local (or .env) — required to authenticate the racecard/odds routes.');
    process.exitCode = 1;
    return;
  }

  console.log(`Nationwide dry-run — ${args.date} — mode ${mode}`);
  console.log('READ/INGESTION BOUNDARY: no model run, recommendation, lock, or result will ever be persisted.');
  if (mode === 'live-provider') {
    console.log('LIVE-PROVIDER MODE: racecard + odds ingestion WILL write races/runners/market_snapshots/runner_quotes.');
  }

  const deps = defaultProducerOwnershipDeps();
  const acquireResult = await acquireNationwideOwnership(
    { raceDate: args.date, mode: toOwnershipMode(mode), ttlSeconds: PRODUCER_CLAIM_DEFAULT_TTL_SECONDS },
    deps,
  );
  if (!acquireResult.ok) {
    const { message, exitCode } = describeAcquireFailure(acquireResult);
    console.error(message);
    process.exitCode = exitCode;
    return; // Structurally guaranteed: no provider call, no scoring, no write beyond the failed acquire attempt.
  }
  const state = acquireResult.state;
  const heartbeat = createNationwideHeartbeatController(state, deps, PRODUCER_CLAIM_DEFAULT_TTL_SECONDS);
  heartbeat.start();

  let providerStages: ProviderStageSummary[] = [];
  let reconciliation: NationwideDryRunReport['reconciliation'] = null;
  let timing: NationwideDryRunReport['timing'] = null;
  let blockedAtStage: string | null = null;
  let blockedReason: string | null = null;
  let exitCode = 0;

  try {
    if (mode === 'live-provider') {
      const now = new Date();
      const baseUrl = args.baseUrl.replace(/\/+$/, '');
      const callCron = createCallCron();

      // Verify BEFORE racecards.
      await heartbeat.beatNow();
      if (!state.believed) {
        const d = describeStopReason(state.stopReason!);
        blockedAtStage = 'before_racecards';
        blockedReason = d.message;
        exitCode = d.exitCode;
      } else {
        const dayParam = dayParamForDate(args.date, now);
        if (!dayParam) {
          providerStages.push({ stage: 'racecards', status: 'skipped', detail: `${args.date} is not today/tomorrow — Racing API cannot serve it` });
        } else {
          const racecardsUrl = buildUrl(baseUrl, '/api/cron/racecards', { day: dayParam });
          const { ok, body } = await callCron(racecardsUrl);
          if (!ok) {
            providerStages.push({ stage: 'racecards', status: 'failed', detail: 'racecards route failed — stopping (no stale fallback)' });
            blockedAtStage = 'racecards';
            blockedReason = 'racecard-stage failure stops the run; no --allow-stale exists';
            exitCode = 1;
          } else if (body === null || typeof body !== 'object') {
            providerStages.push({ stage: 'racecards', status: 'failed', detail: 'malformed racecards response — stopping before scoring' });
            blockedAtStage = 'racecards';
            blockedReason = 'malformed provider response stops the run before scoring';
            exitCode = 1;
          } else {
            providerStages.push({ stage: 'racecards', status: 'ok', detail: 'racecards route responded' });
          }
        }

        // Verify AFTER racecards (only if not already blocked).
        if (blockedAtStage === null) {
          await heartbeat.beatNow();
          if (!state.believed) {
            const d = describeStopReason(state.stopReason!);
            blockedAtStage = 'after_racecards';
            blockedReason = d.message;
            exitCode = d.exitCode;
          }
        }

        // Verify BEFORE odds.
        if (blockedAtStage === null) {
          await heartbeat.beatNow();
          if (!state.believed) {
            const d = describeStopReason(state.stopReason!);
            blockedAtStage = 'before_odds';
            blockedReason = d.message;
            exitCode = d.exitCode;
          }
        }

        if (blockedAtStage === null) {
          const oddsUrl = buildUrl(baseUrl, '/api/cron/odds', { date: args.date });
          const { ok, body } = await callCron(oddsUrl);
          if (!ok) {
            providerStages.push({ stage: 'odds', status: 'failed', detail: 'odds route failed — stopping before scoring (no stale fallback)' });
            blockedAtStage = 'odds';
            blockedReason = 'odds-stage failure stops the run; no --allow-stale exists';
            exitCode = 1;
          } else if (body === null || typeof body !== 'object') {
            providerStages.push({ stage: 'odds', status: 'failed', detail: 'malformed odds response — stopping before scoring' });
            blockedAtStage = 'odds';
            blockedReason = 'malformed provider response stops the run before scoring';
            exitCode = 1;
          } else {
            const b = body as { racesConsidered?: unknown; marketsMatched?: unknown };
            providerStages.push({
              stage: 'odds',
              status: 'ok',
              detail: `odds route responded (considered=${String(b.racesConsidered ?? '?')} matched=${String(b.marketsMatched ?? '?')})`,
            });
          }
        }

        // Verify AFTER odds.
        if (blockedAtStage === null) {
          await heartbeat.beatNow();
          if (!state.believed) {
            const d = describeStopReason(state.stopReason!);
            blockedAtStage = 'after_odds';
            blockedReason = d.message;
            exitCode = d.exitCode;
          }
        }
      }
    } else {
      providerStages = []; // stored-only: no provider stages at all.
    }

    if (blockedAtStage === null) {
      // Reconcile stored nationwide workload (both modes).
      const client = createSupabaseWorkloadClient();
      const gathered = await fetchNationwideWorkloadRows(client, args.date);
      if (gathered.rows === null) {
        blockedAtStage = 'reconcile';
        blockedReason = gathered.error ?? 'workload read failed';
        exitCode = 1;
      } else {
        reconciliation = reconcileNationwideWorkload(gathered.rows);
        console.log(
          `Reconciliation: ${reconciliation.totals.courses} course(s), ${reconciliation.totals.races} race(s), ` +
            `${reconciliation.totals.races_with_odds}/${reconciliation.totals.races} with odds.`,
        );
        for (const w of reconciliation.warnings) console.log(`  [WARN] ${w}`);
        if (!reconciliation.ok) {
          blockedAtStage = 'reconcile';
          blockedReason = reconciliation.blockReason;
          exitCode = 1;
        } else {
          // Verify BEFORE scoring.
          await heartbeat.beatNow();
          if (!state.believed) {
            const d = describeStopReason(state.stopReason!);
            blockedAtStage = 'before_scoring';
            blockedReason = d.message;
            exitCode = d.exitCode;
          } else {
            const { inputs, stoppedEarly } = await scoreEligibleRaces(gathered.rows, state, () => heartbeat.beatNow());
            timing = buildNationwideTimingReport(args.date, inputs);
            console.log(
              `Scoring: ${timing.races_scored}/${timing.races_considered} scored, ` +
                `${timing.races_skipped_no_priced_field} zero-priced, ${timing.races_failed} failed.`,
            );
            if (stoppedEarly) {
              const d = state.stopReason ? describeStopReason(state.stopReason) : { message: 'ownership lost during scoring', exitCode: 3 };
              blockedAtStage = 'scoring';
              blockedReason = d.message;
              exitCode = d.exitCode;
            }
          }
        }
      }
    }
  } finally {
    await releaseNationwideOwnership(state, heartbeat, deps);
  }

  const completed = blockedAtStage === null;
  const report: NationwideDryRunReport = {
    date: args.date,
    mode,
    scope: state.scope,
    ownerPrefix: state.ownerId.slice(0, 8),
    generation: state.generation,
    claimStart: 'acquired',
    claimEnd: completed || exitCode === 0 ? 'released' : state.stopReason ?? 'released',
    providerStages,
    reconciliation,
    timing,
    commandDurationMs: performance.now() - startedAt,
    completed,
    blockedAtStage,
    blockedReason,
  };

  console.log(`\nOutcome: ${completed ? 'COMPLETED' : `STOPPED at "${blockedAtStage}" — ${blockedReason}`}`);
  console.log('No model runs, recommendations, locks, or results were persisted. No bet was placed.');

  if (args.report) {
    const path = buildNationwideDryRunPath(args.date, mode);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderNationwideDryRunMarkdown(report, new Date().toISOString()), 'utf8');
    console.log(`\nReport written: ${path}`);
  }

  if (!completed) process.exitCode = exitCode;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
