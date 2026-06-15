/**
 * Supabase data access for race data used by the betting pipeline.
 *
 * Column/table names below are aligned to the REAL database schema (verified
 * 2026-06-12). Centralised as constants so a schema change is a one-line edit.
 *
 * Verified schema (relevant columns):
 * - `races`           : id (PK), meeting_date, off_time, course, country, status, ...
 * - `runners`         : id (PK), race_id, horse_name, trainer
 * - `market_snapshots`: id (PK), race_id, snapshot_time, overround, liquidity, ...
 * - `runner_quotes`   : id, snapshot_id (-> market_snapshots), runner_id,
 *                       quote_type, bookmaker_name, odds_decimal, implied_prob
 *   -> runner_quotes has NO race_id/timestamp; the snapshot carries both.
 *      "Latest odds" = newest market_snapshot for the race, best decimal price
 *      per runner within it.
 *
 * Verified tipster schema (2026-06-12):
 * - `tipsters`        : id (PK), canonical_name, display_name, affiliation, ...
 * - `tipster_aliases` : id, tipster_id, source_id, alias_name, alias_affiliation,
 *                       confidence
 * - `tipster_priors`  : tipster_id, as_of_date, roi_bsp_gross, ae_bsp,
 *                       strike_rate, prior_weight, ... (latest = max as_of_date)
 * - `tipster_review_queue`: id, raw_name, raw_affiliation, created_at
 *
 * MISSING: there is NO `tipster_selections` table. `fetchTipsterSelections` and
 * `ingestTipsterSelections` therefore have no backing table and will fail at
 * runtime until such a table exists (or those flows are redesigned).
 */

import { supabaseAdmin } from './supabaseAdmin';
import type { SkippedRunReason } from './modelRunAttempts';
import {
  getModelObservabilityFromConfig,
  type ModelRunObservability,
} from './modelRunConfigReaders';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TipsterSelection } from './modelProbabilities';

const RACES_TABLE = 'races';
const RUNNERS_TABLE = 'runners';
const MARKET_SNAPSHOTS_TABLE = 'market_snapshots';
const RUNNER_QUOTES_TABLE = 'runner_quotes';
const MODEL_RUNS_TABLE = 'model_runs';
const MODEL_RUNNER_SCORES_TABLE = 'model_runner_scores';
const RECOMMENDATIONS_TABLE = 'recommendations';
const TIPSTER_SELECTIONS_TABLE = 'tipster_selections';
const TIPSTER_PRIORS_TABLE = 'tipster_priors';
const TIPSTERS_TABLE = 'tipsters';
const TIPSTER_ALIASES_TABLE = 'tipster_aliases';
const TIPSTER_REVIEW_QUEUE_TABLE = 'tipster_review_queue';

/** Canonical-name column on `tipsters`, used for the exact-match fallback. */
const CANONICAL_NAME_COLUMN = 'canonical_name';

/** Affiliation column on `tipster_aliases` (scopes an alias match). */
const ALIAS_AFFILIATION_COLUMN = 'alias_affiliation';

/** Snapshot-time column on `market_snapshots` used to find the latest snapshot. */
const SNAPSHOT_TIME_COLUMN = 'snapshot_time';

/** Calendar-date column on `races` used to select today's meetings. */
const RACE_MEETING_DATE_COLUMN = 'meeting_date';

/** Date column on `tipster_priors` used to find each tipster's latest record. */
const TIPSTER_PRIORS_TIMESTAMP_COLUMN = 'as_of_date';

/** Running bankroll balance ledger; latest balance = newest `entry_time`. */
const BANKROLL_LEDGER_TABLE = 'bankroll_ledger';

/** Timestamp column on `bankroll_ledger` used to find the latest balance. */
const BANKROLL_LEDGER_TIMESTAMP_COLUMN = 'entry_time';

type Id = string | number;

export interface RunnerWithOdds {
  runner_id: Id;
  horse_name: string;
  odds_decimal: number;
}

export interface TipsterPriorStats {
  tipster_id: Id;
  roi_bsp_gross: number;
  ae_bsp: number;
  strike_rate: number;
}

interface RunnerRow {
  runner_id: Id;
  horse_name: string;
}

interface QuoteRow {
  runner_id: Id;
  odds_decimal: number | string | null;
}

interface TipsterPriorRow {
  tipster_id: Id;
  roi_bsp_gross: number | string | null;
  ae_bsp: number | string | null;
  strike_rate: number | string | null;
}

/** Coerces a possibly null/string DB value to a finite number, else `fallback`. */
function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Emits a diagnostic trace line only when `DEBUG_MODEL=1` in the environment;
 * silent (no-op) otherwise. Used to diagnose why a race produces no model run.
 */
function traceModel(message: string): void {
  if (process.env.DEBUG_MODEL === '1') {
    console.log(message);
  }
}

/**
 * Fetches all runners for a race joined with their latest decimal odds.
 *
 * Odds come from the newest `market_snapshots` row for the race; within that
 * snapshot the best (max) `odds_decimal` per runner is used. Runners with no
 * usable price (no snapshot, missing/non-numeric, or <= 1) are omitted, since
 * they cannot be priced for EV/staking.
 *
 * @throws if any Supabase query fails.
 */
export async function fetchRunnersWithOdds(
  raceId: string,
): Promise<RunnerWithOdds[]> {
  const { data: runnerData, error: runnersError } = await supabaseAdmin
    .from(RUNNERS_TABLE)
    .select('runner_id:id, horse_name')
    .eq('race_id', raceId);

  if (runnersError) {
    throw new Error(
      `Failed to fetch runners for race ${raceId}: ${runnersError.message}`,
    );
  }

  const runnerRows = (runnerData ?? []) as RunnerRow[];
  if (runnerRows.length === 0) {
    return [];
  }

  // Latest market snapshot for the race (odds live on its runner_quotes).
  const { data: snapshotData, error: snapshotError } = await supabaseAdmin
    .from(MARKET_SNAPSHOTS_TABLE)
    .select('id')
    .eq('race_id', raceId)
    .order(SNAPSHOT_TIME_COLUMN, { ascending: false })
    .limit(1);

  if (snapshotError) {
    throw new Error(
      `Failed to fetch market snapshots for race ${raceId}: ${snapshotError.message}`,
    );
  }

  const latestSnapshot = ((snapshotData ?? []) as { id: Id }[])[0];
  if (!latestSnapshot) {
    return [];
  }

  // All quotes in that snapshot; keep the best (max) decimal price per runner.
  const { data: quoteData, error: quotesError } = await supabaseAdmin
    .from(RUNNER_QUOTES_TABLE)
    .select('runner_id, odds_decimal')
    .eq('snapshot_id', latestSnapshot.id);

  if (quotesError) {
    throw new Error(
      `Failed to fetch runner quotes for race ${raceId}: ${quotesError.message}`,
    );
  }

  const bestOdds = new Map<Id, number>();
  for (const quote of (quoteData ?? []) as QuoteRow[]) {
    const odds = Number(quote.odds_decimal);
    if (Number.isFinite(odds) && odds > 1) {
      const current = bestOdds.get(quote.runner_id);
      if (current === undefined || odds > current) {
        bestOdds.set(quote.runner_id, odds);
      }
    }
  }

  const result: RunnerWithOdds[] = [];
  for (const runner of runnerRows) {
    const odds = bestOdds.get(runner.runner_id);
    if (odds !== undefined) {
      result.push({
        runner_id: runner.runner_id,
        horse_name: runner.horse_name,
        odds_decimal: odds,
      });
    }
  }
  return result;
}

/** A priced runner plus its de-overrounded market probability. */
export interface ModelInputRunner {
  runner_id: string;
  horse_name: string;
  odds_decimal: number;
  /** De-overrounded market-implied win probability in [0, 1] (sums to 1). */
  market_prob: number;
}

/** Inputs for a model run: the snapshot it is priced from + its priced field. */
export interface RaceModelInputs {
  /** `market_snapshots.id` the odds came from (required by `model_runs`). */
  snapshot_id: string;
  /**
   * `market_snapshots.snapshot_time` of the snapshot the odds came from (ISO),
   * or `null` when the snapshot has no timestamp. Used to assess odds staleness.
   */
  snapshot_time: string | null;
  /**
   * Total runners DECLARED for the race (priced or not). `runners.length` below
   * counts only the PRICED field, so this is kept separately to assess market
   * completeness (declared vs priced) without re-querying.
   */
  declared_runner_count: number;
  runners: ModelInputRunner[];
}

/**
 * Optional out-param for {@link fetchRaceModelInputs} that reports WHY a model
 * run would be skipped, so the caller can log a precise reason. Mutated in place
 * (the function's return type is unchanged, so existing callers are unaffected):
 * `skipReason` is set to the cause when the inputs are unusable, else `null`.
 */
export interface RaceModelInputsDiagnostics {
  skipReason: SkippedRunReason | null;
}

/**
 * Gathers the inputs a model run needs for a race: the latest market snapshot
 * id and, for every priced runner, its best decimal odds and de-overrounded
 * market probability.
 *
 * Odds = best (max) `odds_decimal` per runner within the newest
 * `market_snapshots` row. Market probabilities are `1/odds` normalised across
 * the priced field so they sum to 1 (strips the book overround).
 *
 * Returns `null` when the race has no runners or no market snapshot (a model
 * run cannot be created without a snapshot to anchor it). When `diagnostics` is
 * supplied, its `skipReason` is set to the precise cause (or `null` on success)
 * for lightweight logging — this does not change the return value.
 *
 * @throws if any Supabase query fails.
 */
export async function fetchRaceModelInputs(
  raceId: string,
  diagnostics?: RaceModelInputsDiagnostics,
): Promise<RaceModelInputs | null> {
  if (diagnostics) {
    diagnostics.skipReason = null;
  }
  const { data: runnerData, error: runnersError } = await supabaseAdmin
    .from(RUNNERS_TABLE)
    .select('id, horse_name')
    .eq('race_id', raceId);

  if (runnersError) {
    throw new Error(
      `Failed to fetch runners for race ${raceId}: ${runnersError.message}`,
    );
  }

  const runnerRows = (runnerData ?? []) as { id: Id; horse_name: string }[];
  traceModel(
    `[trace] step1 runners (runners.race_id=${raceId}): ${runnerRows.length} row(s)`,
  );
  if (runnerRows.length === 0) {
    if (diagnostics) {
      diagnostics.skipReason = 'NO_DECLARED_RUNNERS';
    }
    return null;
  }

  const { data: snapshotData, error: snapshotError } = await supabaseAdmin
    .from(MARKET_SNAPSHOTS_TABLE)
    .select('id, snapshot_time')
    .eq('race_id', raceId)
    .order(SNAPSHOT_TIME_COLUMN, { ascending: false })
    .limit(1);

  if (snapshotError) {
    throw new Error(
      `Failed to fetch market snapshots for race ${raceId}: ${snapshotError.message}`,
    );
  }

  const latestSnapshot = ((snapshotData ?? []) as {
    id: Id;
    snapshot_time: string | null;
  }[])[0];
  traceModel(
    `[trace] step2 market_snapshots (race_id=${raceId}): ${
      (snapshotData ?? []).length
    } row(s); latest id=${latestSnapshot ? latestSnapshot.id : 'NONE'}`,
  );
  if (!latestSnapshot) {
    if (diagnostics) {
      diagnostics.skipReason = 'NO_MARKET_SNAPSHOT';
    }
    return null;
  }

  const { data: quoteData, error: quotesError } = await supabaseAdmin
    .from(RUNNER_QUOTES_TABLE)
    .select('runner_id, odds_decimal')
    .eq('snapshot_id', latestSnapshot.id);

  if (quotesError) {
    throw new Error(
      `Failed to fetch runner quotes for race ${raceId}: ${quotesError.message}`,
    );
  }

  traceModel(
    `[trace] step3 runner_quotes (snapshot_id=${latestSnapshot.id}): ${
      (quoteData ?? []).length
    } row(s)`,
  );

  const bestOdds = new Map<string, number>();
  for (const quote of (quoteData ?? []) as QuoteRow[]) {
    const odds = Number(quote.odds_decimal);
    if (Number.isFinite(odds) && odds > 1) {
      const key = String(quote.runner_id);
      const current = bestOdds.get(key);
      if (current === undefined || odds > current) {
        bestOdds.set(key, odds);
      }
    }
  }

  const priced = runnerRows
    .map((r) => ({
      runner_id: String(r.id),
      horse_name: r.horse_name,
      odds_decimal: bestOdds.get(String(r.id)),
    }))
    .filter(
      (r): r is { runner_id: string; horse_name: string; odds_decimal: number } =>
        r.odds_decimal !== undefined,
    );

  traceModel(
    `[trace] step3b priced runners (matched a quote with odds > 1): ${priced.length} of ${runnerRows.length}`,
  );

  const totalImplied = priced.reduce((sum, r) => sum + 1 / r.odds_decimal, 0);
  const runners: ModelInputRunner[] = priced.map((r) => ({
    ...r,
    market_prob: totalImplied > 0 ? 1 / r.odds_decimal / totalImplied : 0,
  }));

  // Snapshot + declared runners exist, but none are priced: a usable model run
  // cannot be built. Reported for logging; the return value is unchanged (an
  // inputs object with an empty `runners` field, as before).
  if (diagnostics && runners.length === 0) {
    diagnostics.skipReason = 'NO_PRICED_RUNNERS';
  }

  return {
    snapshot_id: String(latestSnapshot.id),
    snapshot_time: latestSnapshot.snapshot_time
      ? String(latestSnapshot.snapshot_time)
      : null,
    declared_runner_count: runnerRows.length,
    runners,
  };
}

/**
 * Fetches tipster selections for a race as `{ runner_id, tipster_id }`.
 *
 * Returns an empty array when there are no selections.
 *
 * @throws if the Supabase query fails.
 */
export async function fetchTipsterSelections(
  raceId: string,
): Promise<TipsterSelection[]> {
  const { data, error } = await supabaseAdmin
    .from(TIPSTER_SELECTIONS_TABLE)
    .select('runner_id, tipster_id')
    .eq('race_id', raceId);

  if (error) {
    throw new Error(
      `Failed to fetch tipster selections for race ${raceId}: ${error.message}`,
    );
  }

  traceModel(
    `[trace] step4 tipster_selections (race_id=${raceId}): ${
      (data ?? []).length
    } row(s)`,
  );

  return (data ?? []) as TipsterSelection[];
}

/**
 * Fetches the most recent bankroll balance from `bankroll_ledger`, i.e. the
 * `balance_after` of the row with the newest `entry_time`.
 *
 * Returns `null` when the ledger is empty (no rows) or the latest balance is
 * missing/non-numeric, so callers can decide on a fallback. A real balance is
 * returned as-is (including `0`/negative — that is a genuine "out of funds"
 * state, not an empty ledger).
 *
 * @throws if the Supabase query fails (a query error is distinct from an empty
 *   ledger and should surface rather than silently fall back).
 */
export async function fetchLatestBankroll(): Promise<number | null> {
  const { data, error } = await supabaseAdmin
    .from(BANKROLL_LEDGER_TABLE)
    .select('balance_after')
    .order(BANKROLL_LEDGER_TIMESTAMP_COLUMN, { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`Failed to fetch bankroll ledger: ${error.message}`);
  }

  const latest = ((data ?? []) as { balance_after: number | string | null }[])[0];
  if (latest == null || latest.balance_after == null) {
    return null;
  }

  const balance = Number(latest.balance_after);
  return Number.isFinite(balance) ? balance : null;
}

/**
 * Fetches the IDs of all races whose `meeting_date` is today.
 *
 * `races.meeting_date` is a calendar DATE, so "today" is matched directly
 * against the UTC date of `now`. Pass a different `now` (or adjust to a local
 * timezone) if your meetings roll over on a non-UTC boundary.
 *
 * @throws if the Supabase query fails.
 */
export async function fetchTodaysRaceIds(now: Date = new Date()): Promise<string[]> {
  const meetingDate = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

  const { data, error } = await supabaseAdmin
    .from(RACES_TABLE)
    .select('id')
    .eq(RACE_MEETING_DATE_COLUMN, meetingDate);

  if (error) {
    throw new Error(`Failed to fetch today's races: ${error.message}`);
  }

  return ((data ?? []) as { id: Id }[]).map((row) => String(row.id));
}

/**
 * Fetches the IDs of all races whose `meeting_date` falls within the inclusive
 * `[fromDate, toDate]` range (both `YYYY-MM-DD` calendar dates), ordered by
 * date. Used by the backtest harness to evaluate a window of meetings.
 *
 * @throws if the Supabase query fails.
 */
export async function fetchRaceIdsInRange(
  fromDate: string,
  toDate: string,
): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from(RACES_TABLE)
    .select('id')
    .gte(RACE_MEETING_DATE_COLUMN, fromDate)
    .lte(RACE_MEETING_DATE_COLUMN, toDate)
    .order(RACE_MEETING_DATE_COLUMN, { ascending: true });

  if (error) {
    throw new Error(
      `Failed to fetch races in range ${fromDate}..${toDate}: ${error.message}`,
    );
  }

  return ((data ?? []) as { id: Id }[]).map((row) => String(row.id));
}

/**
 * A bet recommendation as computed by the DB model pipeline (read-only view).
 *
 * Sourced by joining `recommendations` (staking decision) with
 * `model_runner_scores` (probabilities/EV) and `runners` (horse name) for a
 * race's latest `model_run`.
 */
export interface RaceRecommendation {
  race_id: string;
  runner_id: string;
  horse_name: string;
  /** 1-based rank within the race (recommendations.recommendation_rank). */
  rank: number;
  /**
   * Model's implied price, derived as `1 / market_prob` (fair odds, not a
   * specific book's offered price). `null` when market_prob is unavailable.
   */
  odds: number | null;
  model_prob: number | null;
  market_prob: number | null;
  /** Expected value per unit staked (model_runner_scores.ev_per_1). */
  ev: number | null;
  /** Pre-computed label, e.g. 'high' | 'medium' | 'low'. */
  confidence_label: string;
  confidence_score: number | null;
  stake_pct: number;
  stake_amount: number;
}

interface ModelRunRow {
  id: Id;
  run_time: string;
}
interface RecommendationRow {
  runner_id: Id;
  recommendation_rank: number;
  confidence_label: string;
  stake_pct: number | string | null;
  stake_amount: number | string | null;
}
interface ScoreRow {
  runner_id: Id;
  market_prob: number | string | null;
  model_prob: number | string | null;
  ev_per_1: number | string | null;
  confidence_score: number | string | null;
}

/** Coerces a possibly null/string DB numeric to a number, or `null`. */
function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Fetches the DB-computed recommendations for a race's latest model run,
 * ordered by `recommendation_rank` (best first).
 *
 * Reads (no writes): finds the newest `model_runs` row for the race, then joins
 * its `recommendations`, `model_runner_scores`, and the race's `runners` in
 * TypeScript (explicit, so it does not rely on PostgREST relationship
 * detection). Returns `[]` when the race has no model run yet.
 *
 * @throws if any Supabase query fails.
 */
export async function fetchRaceRecommendations(
  raceId: string,
): Promise<RaceRecommendation[]> {
  // Latest CURRENT model run for the race (append-only history: superseded runs
  // are retained but excluded here via is_current).
  const { data: runData, error: runError } = await supabaseAdmin
    .from(MODEL_RUNS_TABLE)
    .select('id, run_time')
    .eq('race_id', raceId)
    .eq('is_current', true)
    .order('run_time', { ascending: false })
    .limit(1);

  if (runError) {
    throw new Error(
      `Failed to fetch model runs for race ${raceId}: ${runError.message}`,
    );
  }

  const latestRun = ((runData ?? []) as ModelRunRow[])[0];
  if (!latestRun) {
    return [];
  }

  // Recommendations, scores, and runner names for that run, in parallel.
  const [recsResult, scoresResult, runnersResult] = await Promise.all([
    supabaseAdmin
      .from(RECOMMENDATIONS_TABLE)
      .select(
        'runner_id, recommendation_rank, confidence_label, stake_pct, stake_amount',
      )
      .eq('model_run_id', latestRun.id)
      .order('recommendation_rank', { ascending: true }),
    supabaseAdmin
      .from(MODEL_RUNNER_SCORES_TABLE)
      .select('runner_id, market_prob, model_prob, ev_per_1, confidence_score')
      .eq('model_run_id', latestRun.id),
    supabaseAdmin
      .from(RUNNERS_TABLE)
      .select('id, horse_name')
      .eq('race_id', raceId),
  ]);

  if (recsResult.error) {
    throw new Error(
      `Failed to fetch recommendations for race ${raceId}: ${recsResult.error.message}`,
    );
  }
  if (scoresResult.error) {
    throw new Error(
      `Failed to fetch model runner scores for race ${raceId}: ${scoresResult.error.message}`,
    );
  }
  if (runnersResult.error) {
    throw new Error(
      `Failed to fetch runners for race ${raceId}: ${runnersResult.error.message}`,
    );
  }

  const scoreByRunner = new Map<string, ScoreRow>(
    ((scoresResult.data ?? []) as ScoreRow[]).map((s) => [
      String(s.runner_id),
      s,
    ]),
  );
  const nameByRunner = new Map<string, string>(
    ((runnersResult.data ?? []) as { id: Id; horse_name: string }[]).map(
      (r) => [String(r.id), r.horse_name],
    ),
  );

  return ((recsResult.data ?? []) as RecommendationRow[]).map((rec) => {
    const score = scoreByRunner.get(String(rec.runner_id));
    const marketProb = toNumberOrNull(score?.market_prob);
    return {
      race_id: raceId,
      runner_id: String(rec.runner_id),
      horse_name: nameByRunner.get(String(rec.runner_id)) ?? '(unknown)',
      rank: rec.recommendation_rank,
      odds: marketProb && marketProb > 0 ? 1 / marketProb : null,
      model_prob: toNumberOrNull(score?.model_prob),
      market_prob: marketProb,
      ev: toNumberOrNull(score?.ev_per_1),
      confidence_label: rec.confidence_label,
      confidence_score: toNumberOrNull(score?.confidence_score),
      stake_pct: toNumber(rec.stake_pct),
      stake_amount: toNumber(rec.stake_amount),
    };
  });
}

/** A runner as shown on a race card (market + model fields, all nullable). */
export interface RaceCardRunner {
  runner_id: string;
  horse_name: string;
  /** Actual best decimal odds from the market snapshot; null if unpriced. */
  odds: number | null;
  /** De-overrounded market-implied win prob (1/odds, renormalised to sum 1). */
  market_prob: number | null;
  model_prob: number | null;
  /** model_prob - market_prob (how far the model diverges from the market). */
  edge: number | null;
  /** Expected value per unit staked. */
  ev: number | null;
  confidence_score: number | null;
  /** 1-based EV rank within the race (model_runner_scores.rank_in_race). */
  rank: number | null;
}

/** The model's rank-1 pick for a race, with its staking decision + rationale. */
export interface RaceCardPick extends RaceCardRunner {
  confidence_label: string;
  stake_amount: number;
  stake_pct: number;
  /** Raw recommendations.rationale_json (used to derive the "Why" tags). */
  rationale: Record<string, unknown> | null;
  /** True when this pick is also the market favourite (shortest odds). */
  isFavourite: boolean;
}

/** Everything one race card needs: meta, market favourite, model pick, alts. */
export interface RaceCard {
  race_id: string;
  /** Scheduled off time (ISO string) for the countdown; null if unknown. */
  off_time: string | null;
  course: string | null;
  race_name: string | null;
  /** Shortest-odds runner (the market favourite), or null if no priced field. */
  favourite: RaceCardRunner | null;
  /** Rank-1 recommendation (the model's bet), or null when there is no run. */
  modelPick: RaceCardPick | null;
  /** Up to two alternative runners (EV rank 2-3), excluding the model pick. */
  alternatives: RaceCardRunner[];
  /**
   * Observational model outputs read from the current run's `config_json`
   * (data quality + tipster consensus). Always present but null-safe: every
   * field is null / `[]` when the run is missing or lacks the key. Read-only;
   * not used by any decision logic. (Batch J1.)
   */
  observability: ModelRunObservability;
}

interface ScoreRankRow {
  runner_id: Id;
  market_prob: number | string | null;
  model_prob: number | string | null;
  edge: number | string | null;
  ev_per_1: number | string | null;
  confidence_score: number | string | null;
  rank_in_race: number | null;
}

interface RecommendationCardRow extends RecommendationRow {
  rationale_json: unknown;
}

/**
 * Assembles the full read-model for a single race card: race meta, the market
 * favourite (shortest odds), the model's rank-1 pick (with stake + rationale),
 * and the next 1-2 runners by EV as alternatives.
 *
 * Market data (odds, favourite, market_prob) comes from the latest market
 * snapshot via {@link fetchRaceModelInputs}; model data (model_prob, edge, EV,
 * confidence, rank) comes from the latest model run's `model_runner_scores`,
 * and the staking decision from its single `recommendations` row. Returns a
 * card with `favourite`/`modelPick` set to `null` when that data is absent
 * (unpriced race, or no model run yet).
 *
 * @throws if any Supabase query fails.
 */
export async function fetchRaceCard(raceId: string): Promise<RaceCard> {
  // 1. Race meta for the header + countdown.
  const { data: raceData, error: raceError } = await supabaseAdmin
    .from(RACES_TABLE)
    .select('off_time, course, race_name')
    .eq('id', raceId)
    .limit(1);

  if (raceError) {
    throw new Error(
      `Failed to fetch race ${raceId}: ${raceError.message}`,
    );
  }

  const meta = ((raceData ?? []) as {
    off_time: string | null;
    course: string | null;
    race_name: string | null;
  }[])[0];

  const card: RaceCard = {
    race_id: raceId,
    off_time: meta?.off_time ?? null,
    course: meta?.course ?? null,
    race_name: meta?.race_name ?? null,
    favourite: null,
    modelPick: null,
    alternatives: [],
    // Empty/null-safe default; populated from the current run's config_json below
    // (stays empty when the race has no current model run).
    observability: getModelObservabilityFromConfig(null),
  };

  // 2. Market data (odds + de-overrounded probs) from the latest snapshot.
  const inputs = await fetchRaceModelInputs(raceId);
  const marketByRunner = new Map<string, ModelInputRunner>();
  if (inputs) {
    for (const r of inputs.runners) {
      marketByRunner.set(r.runner_id, r);
    }
    // Favourite = the shortest price (lowest odds_decimal) in the field.
    const fav = inputs.runners.reduce<ModelInputRunner | null>(
      (best, r) => (best === null || r.odds_decimal < best.odds_decimal ? r : best),
      null,
    );
    if (fav) {
      card.favourite = {
        runner_id: fav.runner_id,
        horse_name: fav.horse_name,
        odds: fav.odds_decimal,
        market_prob: fav.market_prob,
        model_prob: null,
        edge: null,
        ev: null,
        confidence_score: null,
        rank: null,
      };
    }
  }

  // 3. Latest CURRENT model run for the race (superseded runs are retained in
  //    history but excluded here via is_current). `config_json` carries the
  //    observational outputs surfaced below (Batch J1).
  const { data: runData, error: runError } = await supabaseAdmin
    .from(MODEL_RUNS_TABLE)
    .select('id, run_time, config_json')
    .eq('race_id', raceId)
    .eq('is_current', true)
    .order('run_time', { ascending: false })
    .limit(1);

  if (runError) {
    throw new Error(
      `Failed to fetch model runs for race ${raceId}: ${runError.message}`,
    );
  }

  const latestRun = ((runData ?? []) as (ModelRunRow & {
    config_json: unknown;
  })[])[0];
  if (!latestRun) {
    return card; // No run yet: show race + favourite only (observability empty).
  }

  // Surface the run's observational outputs (read-only, null-safe).
  card.observability = getModelObservabilityFromConfig(latestRun.config_json);

  // 4. The run's staking decision (rank-1 rec) + per-runner scores.
  const [recsResult, scoresResult] = await Promise.all([
    supabaseAdmin
      .from(RECOMMENDATIONS_TABLE)
      .select(
        'runner_id, recommendation_rank, confidence_label, stake_pct, stake_amount, rationale_json',
      )
      .eq('model_run_id', latestRun.id)
      .order('recommendation_rank', { ascending: true }),
    supabaseAdmin
      .from(MODEL_RUNNER_SCORES_TABLE)
      .select(
        'runner_id, market_prob, model_prob, edge, ev_per_1, confidence_score, rank_in_race',
      )
      .eq('model_run_id', latestRun.id)
      .order('rank_in_race', { ascending: true }),
  ]);

  if (recsResult.error) {
    throw new Error(
      `Failed to fetch recommendations for race ${raceId}: ${recsResult.error.message}`,
    );
  }
  if (scoresResult.error) {
    throw new Error(
      `Failed to fetch model runner scores for race ${raceId}: ${scoresResult.error.message}`,
    );
  }

  const scores = (scoresResult.data ?? []) as ScoreRankRow[];

  // Builds a card runner from a score row, sourcing real odds/name from the
  // market snapshot and falling back to fair odds (1/market_prob) if missing.
  const toRunner = (s: ScoreRankRow): RaceCardRunner => {
    const id = String(s.runner_id);
    const mkt = marketByRunner.get(id);
    const scoreMarketProb = toNumberOrNull(s.market_prob);
    const marketProb = mkt ? mkt.market_prob : scoreMarketProb;
    const odds = mkt
      ? mkt.odds_decimal
      : marketProb && marketProb > 0
        ? 1 / marketProb
        : null;
    return {
      runner_id: id,
      horse_name: mkt?.horse_name ?? '(unknown)',
      odds,
      market_prob: marketProb,
      model_prob: toNumberOrNull(s.model_prob),
      edge: toNumberOrNull(s.edge),
      ev: toNumberOrNull(s.ev_per_1),
      confidence_score: toNumberOrNull(s.confidence_score),
      rank: s.rank_in_race ?? null,
    };
  };

  // Model pick = the single rank-1 recommendation (the bet that was taken).
  const rec1 = ((recsResult.data ?? []) as RecommendationCardRow[])[0];
  if (rec1) {
    const pickId = String(rec1.runner_id);
    const pickScore = scores.find((s) => String(s.runner_id) === pickId);
    const base = pickScore
      ? toRunner(pickScore)
      : toRunner({
          runner_id: rec1.runner_id,
          market_prob: null,
          model_prob: null,
          edge: null,
          ev_per_1: null,
          confidence_score: null,
          rank_in_race: 1,
        });
    card.modelPick = {
      ...base,
      confidence_label: rec1.confidence_label,
      stake_amount: toNumber(rec1.stake_amount),
      stake_pct: toNumber(rec1.stake_pct),
      rationale:
        rec1.rationale_json && typeof rec1.rationale_json === 'object'
          ? (rec1.rationale_json as Record<string, unknown>)
          : null,
      isFavourite: card.favourite
        ? base.runner_id === card.favourite.runner_id
        : false,
    };
  }

  // Alternatives = EV rank 2-3, excluding the model pick.
  const pickRunnerId = card.modelPick?.runner_id ?? null;
  card.alternatives = scores
    .filter(
      (s) =>
        s.rank_in_race != null && s.rank_in_race >= 2 && s.rank_in_race <= 3,
    )
    .filter((s) => String(s.runner_id) !== pickRunnerId)
    .map(toRunner);

  return card;
}

/** The outcome of settling a race (which runner was recorded as the winner). */
export interface SettleResult {
  race_id: string;
  winning_runner_id: string;
}

/**
 * Records a race result by marking the winning runner with `finish_pos = 1` in
 * the `runners` table (the canonical result store; there is no separate results
 * table). Idempotent and corrigible: any previously-recorded winner for the
 * race is demoted (`finish_pos = null`) before the new winner is set, so
 * re-settling with a different runner is safe.
 *
 * Validates that `winningRunnerId` belongs to `raceId` (a boundary check) and
 * throws a "not in race" error otherwise, so a caller cannot mark a runner from
 * another race as the winner.
 *
 * @throws if the runner is not in the race, or if any Supabase query fails.
 */
export async function settleRace(
  raceId: string,
  winningRunnerId: string,
): Promise<SettleResult> {
  // Boundary check: the winner must be one of the race's runners.
  const { data: runnerData, error: runnerError } = await supabaseAdmin
    .from(RUNNERS_TABLE)
    .select('id')
    .eq('race_id', raceId);

  if (runnerError) {
    throw new Error(
      `Failed to fetch runners for race ${raceId}: ${runnerError.message}`,
    );
  }

  const runnerIds = new Set(
    ((runnerData ?? []) as { id: Id }[]).map((r) => String(r.id)),
  );
  if (!runnerIds.has(winningRunnerId)) {
    throw new Error(
      `Runner ${winningRunnerId} is not in race ${raceId}`,
    );
  }

  // Demote any stale winner (keeps re-settlement idempotent). Only touches rows
  // currently marked as winner, so any externally-set placings are preserved.
  const { error: demoteError } = await supabaseAdmin
    .from(RUNNERS_TABLE)
    .update({ finish_pos: null })
    .eq('race_id', raceId)
    .eq('finish_pos', 1)
    .neq('id', winningRunnerId);

  if (demoteError) {
    throw new Error(
      `Failed to clear prior winner for race ${raceId}: ${demoteError.message}`,
    );
  }

  // Mark the winner.
  const { error: winnerUpdateError } = await supabaseAdmin
    .from(RUNNERS_TABLE)
    .update({ finish_pos: 1 })
    .eq('id', winningRunnerId);

  if (winnerUpdateError) {
    throw new Error(
      `Failed to record winner ${winningRunnerId} for race ${raceId}: ${winnerUpdateError.message}`,
    );
  }

  return { race_id: raceId, winning_runner_id: winningRunnerId };
}

/**
 * Model accuracy across all settled races for which the model made a rank-1
 * recommendation. Profit is at level 1pt stakes on the model's pick, settled at
 * Betfair SP (`runners.bsp_decimal`), falling back to the latest quoted
 * `odds_decimal`, then `sp_decimal`, when BSP is unavailable.
 */
export interface ModelAccuracy {
  /** Settled races (winner recorded) that also have a rank-1 model pick. */
  racesSettled: number;
  /** Of those, how many the model's rank-1 pick won. */
  winners: number;
  /** winners / racesSettled * 100 (0 when none settled). */
  strikeRatePct: number;
  /** Cumulative profit/loss in points: +(price-1) per win, -1 per loss. */
  profitPoints: number;
  /** profitPoints / racesSettled * 100 (0 when none settled); stake = 1pt/race. */
  roiPct: number;
  /** When this snapshot was computed (ISO 8601). */
  computedAt: string;
}

interface WinnerRow {
  id: Id;
  race_id: Id;
  bsp_decimal: number | string | null;
  sp_decimal: number | string | null;
}

/**
 * Computes {@link ModelAccuracy} live from current DB state, so it always
 * reflects the latest settled results (no cached/stored aggregate to refresh).
 *
 * A race contributes when it has a recorded winner (`runners.finish_pos = 1`)
 * AND the latest model run for it produced a rank-1 recommendation. The pick's
 * settlement price (only needed when it won, since a loss is always -1pt) is
 * `bsp_decimal` → latest snapshot `odds_decimal` → `sp_decimal`.
 *
 * @throws if any Supabase query fails.
 */
export async function computeModelAccuracy(
  now: Date = new Date(),
): Promise<ModelAccuracy> {
  const empty: ModelAccuracy = {
    racesSettled: 0,
    winners: 0,
    strikeRatePct: 0,
    profitPoints: 0,
    roiPct: 0,
    computedAt: now.toISOString(),
  };

  // 1. Recorded winners across all races (finish_pos = 1).
  const { data: winnerData, error: winnerError } = await supabaseAdmin
    .from(RUNNERS_TABLE)
    .select('id, race_id, bsp_decimal, sp_decimal')
    .eq('finish_pos', 1);

  if (winnerError) {
    throw new Error(`Failed to fetch settled winners: ${winnerError.message}`);
  }

  const winnerByRace = new Map<
    string,
    { winnerId: string; bsp: number | null; sp: number | null }
  >();
  for (const w of (winnerData ?? []) as WinnerRow[]) {
    winnerByRace.set(String(w.race_id), {
      winnerId: String(w.id),
      bsp: toNumberOrNull(w.bsp_decimal),
      sp: toNumberOrNull(w.sp_decimal),
    });
  }
  if (winnerByRace.size === 0) {
    return empty;
  }

  const settledRaceIds = [...winnerByRace.keys()];

  // 2. Latest CURRENT model run per settled race (rows are newest-first;
  //    superseded runs are excluded via is_current).
  const { data: runData, error: runError } = await supabaseAdmin
    .from(MODEL_RUNS_TABLE)
    .select('id, race_id, run_time')
    .in('race_id', settledRaceIds)
    .eq('is_current', true)
    .order('run_time', { ascending: false });

  if (runError) {
    throw new Error(`Failed to fetch model runs: ${runError.message}`);
  }

  const latestRunByRace = new Map<string, string>();
  for (const r of (runData ?? []) as {
    id: Id;
    race_id: Id;
    run_time: string;
  }[]) {
    const raceId = String(r.race_id);
    if (!latestRunByRace.has(raceId)) {
      latestRunByRace.set(raceId, String(r.id)); // first seen = latest
    }
  }
  if (latestRunByRace.size === 0) {
    return empty;
  }

  // 3. Rank-1 recommendation for each of those latest runs.
  const runIds = [...latestRunByRace.values()];
  const { data: recData, error: recError } = await supabaseAdmin
    .from(RECOMMENDATIONS_TABLE)
    .select('race_id, runner_id, recommendation_rank')
    .in('model_run_id', runIds)
    .eq('recommendation_rank', 1);

  if (recError) {
    throw new Error(`Failed to fetch recommendations: ${recError.message}`);
  }

  const pickByRace = new Map<string, string>();
  for (const rec of (recData ?? []) as {
    race_id: Id;
    runner_id: Id;
  }[]) {
    pickByRace.set(String(rec.race_id), String(rec.runner_id));
  }

  // 4. Score each settled race that has a rank-1 pick.
  const scored = [...pickByRace.entries()]
    .map(([raceId, pickId]) => {
      const w = winnerByRace.get(raceId);
      if (!w) {
        return null;
      }
      return {
        raceId,
        won: pickId === w.winnerId,
        bsp: w.bsp,
        sp: w.sp,
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  if (scored.length === 0) {
    return empty;
  }

  // 5. For wins missing a BSP, fall back to the latest quoted odds_decimal.
  //    (Only fetched for the rare win-without-BSP case.)
  const needOdds = scored.filter((s) => s.won && s.bsp === null).map((s) => s.raceId);
  const fallbackOddsByRace = new Map<string, number | null>();
  if (needOdds.length > 0) {
    const results = await Promise.all(
      needOdds.map(async (raceId) => {
        const inputs = await fetchRaceModelInputs(raceId).catch(() => null);
        const winnerId = winnerByRace.get(raceId)?.winnerId;
        const odds =
          inputs?.runners.find((r) => r.runner_id === winnerId)?.odds_decimal ??
          null;
        return [raceId, odds] as const;
      }),
    );
    for (const [raceId, odds] of results) {
      fallbackOddsByRace.set(raceId, odds);
    }
  }

  let winners = 0;
  let profitPoints = 0;
  for (const s of scored) {
    if (!s.won) {
      profitPoints -= 1; // lost the 1pt stake
      continue;
    }
    winners += 1;
    // Winning price: BSP, else latest quoted odds, else official SP.
    const price = s.bsp ?? fallbackOddsByRace.get(s.raceId) ?? s.sp ?? null;
    if (price !== null && price > 1) {
      profitPoints += price - 1;
    }
    // A win with no usable price contributes 0 (cannot value the return);
    // this should not occur once BSP/SP are populated at settlement.
  }

  const racesSettled = scored.length;
  return {
    racesSettled,
    winners,
    strikeRatePct: (winners / racesSettled) * 100,
    profitPoints,
    roiPct: (profitPoints / racesSettled) * 100,
    computedAt: now.toISOString(),
  };
}

/**
 * Fetches the latest prior stats for every tipster from `tipster_priors`.
 *
 * Records are pulled newest-first and de-duplicated by tipster, so each
 * tipster contributes only their most recent row. Missing or non-numeric
 * metrics are coerced to 0. Returns an empty array when the table has no rows.
 *
 * Server-side only: relies on `supabaseAdmin` (service-role) and selects just
 * the needed columns to keep the payload small.
 *
 * @throws if the Supabase query fails.
 */
export async function getTipsterStats(): Promise<TipsterPriorStats[]> {
  const { data, error } = await supabaseAdmin
    .from(TIPSTER_PRIORS_TABLE)
    .select(
      `tipster_id, roi_bsp_gross, ae_bsp, strike_rate, ${TIPSTER_PRIORS_TIMESTAMP_COLUMN}`,
    )
    .order(TIPSTER_PRIORS_TIMESTAMP_COLUMN, { ascending: false });

  if (error) {
    throw new Error(`Failed to fetch tipster stats: ${error.message}`);
  }

  const rows = (data ?? []) as TipsterPriorRow[];
  if (rows.length === 0) {
    return [];
  }

  // Rows are newest-first, so the first row seen per tipster is their latest.
  const seen = new Set<Id>();
  const result: TipsterPriorStats[] = [];
  for (const row of rows) {
    if (seen.has(row.tipster_id)) {
      continue;
    }
    seen.add(row.tipster_id);

    result.push({
      tipster_id: row.tipster_id,
      roi_bsp_gross: toNumber(row.roi_bsp_gross),
      ae_bsp: toNumber(row.ae_bsp),
      strike_rate: toNumber(row.strike_rate),
    });
  }
  return result;
}

/**
 * One tracked tipster's leaderboard row, read straight from the DB. Native
 * `tipster_priors` columns (longRunRoi/strikeRate/reliability/finalWeight/
 * betsCount) come from each tipster's latest proofing row; `recentRoi30d` and
 * `longestLosingStreak` have NO native column and are read from the discovery
 * snapshot stored in `tipsters.notes`. Any field the DB does not store is
 * `null` (the UI shows "—") — nothing is fabricated.
 */
export interface TipsterLeaderboardEntry {
  tipster_id: string;
  name: string;
  /** Native `tipsters.affiliation`. */
  affiliation: string | null;
  /** Proofing source label from the discovery snapshot (`notes.discovery.source`). */
  source: string | null;
  /** All-time / long-run ROI (`tipster_priors.roi_bsp_gross`), a fraction. */
  longRunRoi: number | null;
  /** 30d ROI from `notes.discovery.recent_roi_30d`, a fraction. */
  recentRoi30d: number | null;
  /** Strike rate (`tipster_priors.strike_rate`) in [0, 1]. */
  strikeRate: number | null;
  /** Current longest losing streak from `notes.discovery.longest_losing_streak`. */
  longestLosingStreak: number | null;
  /** Reliability shrinkage `N/(N+400)` (`tipster_priors.reliability`) in [0, 1]. */
  reliability: number | null;
  /** Final model weight (`tipster_priors.prior_weight`). */
  finalWeight: number | null;
  /** Sample size (`tipster_priors.bets_count`). */
  betsCount: number | null;
  /** Active pool membership (`tipsters.is_active`); false = demoted. */
  isActive: boolean;
  /** Date of the latest proofing row (`tipster_priors.as_of_date`). */
  asOfDate: string | null;
}

interface LeaderboardPriorRow {
  tipster_id: Id;
  as_of_date: string;
  roi_bsp_gross: number | string | null;
  strike_rate: number | string | null;
  reliability: number | string | null;
  prior_weight: number | string | null;
  bets_count: number | string | null;
}

/** Reads `recent_roi_30d` + `longest_losing_streak` from a tipster `notes` blob. */
function readDiscoverySnapshot(notes: string | null): {
  source: string | null;
  recentRoi30d: number | null;
  longestLosingStreak: number | null;
} {
  const empty = { source: null, recentRoi30d: null, longestLosingStreak: null };
  if (!notes || notes.trim() === '') {
    return empty;
  }
  try {
    const parsed = JSON.parse(notes) as {
      discovery?: {
        source?: unknown;
        recent_roi_30d?: unknown;
        longest_losing_streak?: unknown;
      };
    };
    const d = parsed.discovery;
    if (!d || typeof d !== 'object') {
      return empty;
    }
    return {
      source: typeof d.source === 'string' ? d.source : null,
      recentRoi30d: toNumberOrNull(d.recent_roi_30d),
      longestLosingStreak: toNumberOrNull(d.longest_losing_streak),
    };
  } catch {
    return empty; // non-JSON human note: no snapshot to read
  }
}

/**
 * Reads the full tipster leaderboard: every tracked tipster (i.e. one that has
 * at least one `tipster_priors` row) joined to `tipsters`, using each tipster's
 * latest proofing row. Includes BOTH active and demoted tipsters so the UI can
 * show them distinctly. Read-only.
 *
 * Native metrics come from `tipster_priors`; `recentRoi30d`/streak come from
 * the `tipsters.notes` discovery snapshot. Sorted by `finalWeight` (prior
 * weight) descending, nulls last. Fabricates nothing — missing fields are null.
 *
 * @throws if a required query fails.
 */
export async function fetchTipsterLeaderboard(): Promise<TipsterLeaderboardEntry[]> {
  // All proofing rows, newest-first; keep the latest per tipster.
  const { data: priorData, error: priorError } = await supabaseAdmin
    .from(TIPSTER_PRIORS_TABLE)
    .select(
      'tipster_id, as_of_date, roi_bsp_gross, strike_rate, reliability, prior_weight, bets_count',
    )
    .order(TIPSTER_PRIORS_TIMESTAMP_COLUMN, { ascending: false });

  if (priorError) {
    throw new Error(`Failed to fetch tipster priors: ${priorError.message}`);
  }

  const latestPrior = new Map<string, LeaderboardPriorRow>();
  for (const p of (priorData ?? []) as LeaderboardPriorRow[]) {
    const id = String(p.tipster_id);
    if (!latestPrior.has(id)) {
      latestPrior.set(id, p); // first seen = latest (rows are newest-first)
    }
  }
  if (latestPrior.size === 0) {
    return [];
  }

  const tipsterIds = [...latestPrior.keys()];

  // Join the tipster identities (name/affiliation/is_active/notes).
  const { data: tipsterData, error: tipsterError } = await supabaseAdmin
    .from(TIPSTERS_TABLE)
    .select('id, canonical_name, display_name, affiliation, is_active, notes')
    .in('id', tipsterIds);

  if (tipsterError) {
    throw new Error(`Failed to fetch tipsters: ${tipsterError.message}`);
  }

  const tipsterById = new Map<
    string,
    {
      canonical_name: string | null;
      display_name: string | null;
      affiliation: string | null;
      is_active: boolean | null;
      notes: string | null;
    }
  >();
  for (const t of (tipsterData ?? []) as {
    id: Id;
    canonical_name: string | null;
    display_name: string | null;
    affiliation: string | null;
    is_active: boolean | null;
    notes: string | null;
  }[]) {
    tipsterById.set(String(t.id), t);
  }

  const entries: TipsterLeaderboardEntry[] = [];
  for (const [id, prior] of latestPrior) {
    const t = tipsterById.get(id);
    // A prior with no matching tipster row cannot be named/attributed; skip it
    // rather than invent an identity.
    if (!t) {
      continue;
    }
    const snapshot = readDiscoverySnapshot(t.notes);
    entries.push({
      tipster_id: id,
      name: t.display_name || t.canonical_name || '(unnamed)',
      affiliation: t.affiliation ?? null,
      source: snapshot.source,
      longRunRoi: toNumberOrNull(prior.roi_bsp_gross),
      recentRoi30d: snapshot.recentRoi30d,
      strikeRate: toNumberOrNull(prior.strike_rate),
      longestLosingStreak: snapshot.longestLosingStreak,
      reliability: toNumberOrNull(prior.reliability),
      finalWeight: toNumberOrNull(prior.prior_weight),
      betsCount: toNumberOrNull(prior.bets_count),
      isActive: t.is_active ?? false,
      asOfDate: prior.as_of_date ?? null,
    });
  }

  // Default ordering: strongest final weight first, nulls last.
  entries.sort(
    (a, b) => (b.finalWeight ?? -Infinity) - (a.finalWeight ?? -Infinity),
  );
  return entries;
}

/** How a raw tipster name was resolved (or why it wasn't). */
export type TipsterMatchType =
  | 'alias'
  | 'canonical_name'
  | 'ambiguous'
  | 'unresolved';

export interface CanonicalTipsterResolution {
  /** Canonical id, or `null` when the name could not be resolved unambiguously. */
  tipster_id: Id | null;
  /** The original raw name, preserved verbatim for audit/debug. */
  rawName: string;
  /** The original raw affiliation, if one was supplied. */
  rawAffiliation?: string;
  matchType: TipsterMatchType;
  /** True only when this call inserted a review-queue row (a side effect). */
  enqueuedForReview: boolean;
}

export interface ResolveTipsterOptions {
  /**
   * When true, an unresolved or ambiguous raw name is inserted into
   * `tipster_review_queue`. Defaults to false, keeping the function read-only.
   */
  enqueueForReview?: boolean;
}

interface IdRow {
  tipster_id: Id;
}

/**
 * Escapes SQL LIKE wildcards (`\`, `%`, `_`) so an `ilike` query performs a
 * case-insensitive EXACT match rather than a pattern match. This also prevents
 * scraped input from being interpreted as a wildcard pattern.
 */
function escapeLike(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1');
}

/** Distinct ids, compared by string value, preserving first-seen order. */
function uniqueIds(ids: Id[]): Id[] {
  const seen = new Set<string>();
  const out: Id[] = [];
  for (const id of ids) {
    const key = String(id);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(id);
    }
  }
  return out;
}

/**
 * Inserts an unresolved/ambiguous raw name into the review queue, but only when
 * the caller opted in. Returns the resolution, flagging whether a row was added.
 *
 * @throws if the insert fails.
 */
async function enqueueForReviewIfRequested(
  client: SupabaseClient,
  resolution: CanonicalTipsterResolution,
  options: ResolveTipsterOptions,
): Promise<CanonicalTipsterResolution> {
  if (!options.enqueueForReview) {
    return resolution;
  }

  const { error } = await client.from(TIPSTER_REVIEW_QUEUE_TABLE).insert({
    raw_name: resolution.rawName,
    raw_affiliation: resolution.rawAffiliation ?? null,
  });

  if (error) {
    throw new Error(`Failed to enqueue tipster for review: ${error.message}`);
  }

  return { ...resolution, enqueuedForReview: true };
}

/**
 * Looks up the distinct canonical ids for an alias name, optionally scoped to
 * an affiliation. Case-insensitive exact match on `alias_name` (and
 * `alias_affiliation` when provided).
 *
 * @throws if the Supabase query fails.
 */
async function lookupAliasIds(
  client: SupabaseClient,
  aliasName: string,
  affiliation?: string,
): Promise<Id[]> {
  let query = client
    .from(TIPSTER_ALIASES_TABLE)
    .select('tipster_id')
    .ilike('alias_name', escapeLike(aliasName));

  if (affiliation) {
    query = query.ilike(ALIAS_AFFILIATION_COLUMN, escapeLike(affiliation));
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to look up tipster aliases: ${error.message}`);
  }

  return uniqueIds(((data ?? []) as IdRow[]).map((r) => r.tipster_id));
}

/**
 * Resolves a raw, scraped tipster name to a single canonical `tipster_id`
 * before selections reach the model. Deterministic and, by default, read-only.
 *
 * Resolution order (never guesses):
 *   1. `tipster_aliases` — case-insensitive exact match on `alias_name`. When
 *      `rawAffiliation` is supplied, a strict `alias_name` + `affiliation`
 *      match is tried first; if that finds nothing, it safely falls back to an
 *      `alias_name`-only match. Each step resolves only on a single distinct
 *      canonical id; multiple distinct ids are ambiguous (never guesses).
 *   2. `tipsters` — case-insensitive exact match on `canonical_name`, again
 *      requiring a single distinct id.
 *   3. Otherwise unresolved: returns `tipster_id: null`. If
 *      `options.enqueueForReview` is set, the raw name is added to
 *      `tipster_review_queue` for manual triage (the only side effect).
 *
 * The original `rawName`/`rawAffiliation` are always echoed back for audit.
 *
 * @param client Supabase client to query; defaults to the shared service-role
 *   `supabaseAdmin`. Injectable so tests can supply a fake (mock the DB).
 * @throws if any Supabase query fails.
 */
export async function resolveCanonicalTipster(
  rawName: string,
  rawAffiliation?: string,
  options: ResolveTipsterOptions = {},
  client: SupabaseClient = supabaseAdmin,
): Promise<CanonicalTipsterResolution> {
  const trimmedName = (rawName ?? '').trim();
  const trimmedAffiliation = rawAffiliation?.trim() || undefined;

  const base: CanonicalTipsterResolution = {
    tipster_id: null,
    rawName,
    rawAffiliation,
    matchType: 'unresolved',
    enqueuedForReview: false,
  };

  // An empty name has nothing to match and nothing worth reviewing.
  if (trimmedName === '') {
    return base;
  }

  // Step 1: alias lookup (case-insensitive exact match on alias_name).
  // 1a. When an affiliation is supplied, first require a strict
  //     alias_name + affiliation match. A single distinct id resolves; several
  //     distinct ids are ambiguous (never guess). Zero matches fall through to
  //     the safe alias_name-only fallback below.
  if (trimmedAffiliation) {
    const scopedIds = await lookupAliasIds(
      client,
      trimmedName,
      trimmedAffiliation,
    );
    if (scopedIds.length === 1) {
      return { ...base, tipster_id: scopedIds[0], matchType: 'alias' };
    }
    if (scopedIds.length > 1) {
      return enqueueForReviewIfRequested(
        client,
        { ...base, matchType: 'ambiguous' },
        options,
      );
    }
    // else: no affiliation-scoped match — fall through to alias_name-only.
  }

  // 1b. Alias_name-only lookup: the only alias step when no affiliation was
  //     given, and the safe fallback when the scoped match found nothing.
  //     Accept only a single distinct canonical id; several => ambiguous.
  const aliasIds = await lookupAliasIds(client, trimmedName);
  if (aliasIds.length === 1) {
    return { ...base, tipster_id: aliasIds[0], matchType: 'alias' };
  }
  if (aliasIds.length > 1) {
    // One name maps to several canonical ids — do not guess.
    return enqueueForReviewIfRequested(
      client,
      { ...base, matchType: 'ambiguous' },
      options,
    );
  }

  // Step 2: exact (case-insensitive) match on canonical_name. The tipsters PK
  // column is `id`; alias it to `tipster_id` so downstream handling is uniform.
  const { data: canonData, error: canonError } = await client
    .from(TIPSTERS_TABLE)
    .select('tipster_id:id')
    .ilike(CANONICAL_NAME_COLUMN, escapeLike(trimmedName));

  if (canonError) {
    throw new Error(`Failed to look up canonical tipsters: ${canonError.message}`);
  }

  const canonIds = uniqueIds(((canonData ?? []) as IdRow[]).map((r) => r.tipster_id));
  if (canonIds.length === 1) {
    return { ...base, tipster_id: canonIds[0], matchType: 'canonical_name' };
  }
  if (canonIds.length > 1) {
    return enqueueForReviewIfRequested(client, { ...base, matchType: 'ambiguous' }, options);
  }

  // Step 3: no match — unresolved. Do not guess.
  return enqueueForReviewIfRequested(client, base, options);
}

/**
 * A raw tipster selection as parsed from a scrape, before canonicalisation.
 * `rawName`/`rawAffiliation` are the verbatim scraped values.
 */
export interface RawTipsterSelection {
  race_id: Id;
  runner_id: Id;
  rawName: string;
  rawAffiliation?: string;
}

/**
 * A selection row ready to persist into `tipster_selections`. Shape matches the
 * table columns exactly:
 * - `tipster_id` is the resolved canonical id, or `null` when the raw name
 *   could not be resolved unambiguously (downstream review decides).
 * - `raw_tipster_name` / `raw_affiliation` preserve the scraped values for
 *   audit; `raw_affiliation` is `null` when none was scraped.
 */
export interface PreparedTipsterSelectionRow {
  race_id: Id;
  runner_id: Id;
  tipster_id: Id | null;
  raw_tipster_name: string;
  raw_affiliation: string | null;
}

export interface IngestedTipsterSelection {
  /** The row to persist into `tipster_selections` (caller performs the insert). */
  row: PreparedTipsterSelectionRow;
  /** How the raw name resolved (audit/debug only; not a persisted column). */
  matchType: TipsterMatchType;
  /** Whether this ingestion enqueued the raw name for manual review. */
  enqueuedForReview: boolean;
}

/**
 * Canonicalises a single raw scraped selection into a persistable row.
 *
 * Per the ingestion contract, this resolves the raw tipster name via
 * {@link resolveCanonicalTipster} with `enqueueForReview: true`, then:
 * - on a resolved match, writes the canonical `tipster_id` into the row;
 * - on unresolved/ambiguous, leaves `tipster_id` null (never guesses) and the
 *   raw name is queued for review.
 *
 * Either way the raw name/affiliation are preserved on the row for audit.
 *
 * Deterministic, and side-effect free apart from the review-queue insert
 * performed by `resolveCanonicalTipster`. It does NOT persist the selection
 * row itself — the caller decides when/how to write the returned row.
 *
 * @throws if a Supabase lookup or the review-queue insert fails.
 */
export async function ingestTipsterSelection(
  raw: RawTipsterSelection,
): Promise<IngestedTipsterSelection> {
  const resolution = await resolveCanonicalTipster(raw.rawName, raw.rawAffiliation, {
    enqueueForReview: true,
  });

  return {
    row: {
      race_id: raw.race_id,
      runner_id: raw.runner_id,
      // Canonical id when resolved; null when unresolved/ambiguous.
      tipster_id: resolution.tipster_id,
      raw_tipster_name: raw.rawName,
      raw_affiliation: raw.rawAffiliation ?? null,
    },
    matchType: resolution.matchType,
    enqueuedForReview: resolution.enqueuedForReview,
  };
}

/**
 * Canonicalises a batch of raw scraped selections, preserving input order.
 *
 * Processed sequentially so the review-queue side effects are deterministic and
 * not interleaved. Like {@link ingestTipsterSelection}, this prepares rows but
 * does not persist them.
 *
 * @throws if any underlying lookup or review-queue insert fails.
 */
export async function ingestTipsterSelections(
  raws: RawTipsterSelection[],
): Promise<IngestedTipsterSelection[]> {
  const results: IngestedTipsterSelection[] = [];
  for (const raw of raws) {
    results.push(await ingestTipsterSelection(raw));
  }
  return results;
}
