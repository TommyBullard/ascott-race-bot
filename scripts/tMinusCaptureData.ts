/**
 * Shared READ-ONLY data loaders for the T-minus workflows: the capture report
 * CLI (scripts/captureTMinus.ts) and the lock CLI (scripts/lockTMinus.ts).
 *
 * Extracted verbatim from scripts/captureTMinus.ts so both CLIs build a race's
 * T-minus state from the SAME code — the lock can never diverge from what the
 * capture report shows. This module has NO top-level side effects (unlike the
 * CLI entry points, which run main() on import), so it is safe to import.
 *
 * STRICTLY READ-ONLY: it issues only `select` queries via the service-role
 * client. It NEVER runs the model, fetches live odds, imports results, or
 * mutates the database. Nothing is fabricated: a missing value stays null.
 */

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { normalizeCourse } from '../src/lib/raceSync';
import {
  getDataQualityOutputsFromConfig,
  getTipsterConsensusSummaryFromConfig,
  getTipsterModelAlignmentFromConfig,
} from '../src/lib/modelRunConfigReaders';
import {
  selectTMinusRun,
  type TMinusRaceCapture,
  type TMinusRunner,
} from '../src/lib/tMinusCapture';

const RACES_TABLE = 'races';
const RACE_MEETING_DATE_COLUMN = 'meeting_date';
const MODEL_RUNS_TABLE = 'model_runs';
const MODEL_RUNNER_SCORES_TABLE = 'model_runner_scores';
const RECOMMENDATIONS_TABLE = 'recommendations';
const RUNNERS_TABLE = 'runners';
const RUNNER_QUOTES_TABLE = 'runner_quotes';

/** Loads env from `.env.local`, then `.env`; falls back to the shell env. */
export function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      // Not present; try the next, then fall back to shell env.
    }
  }
}

/** Coerces a possibly null/string DB numeric to a number, or `null`. */
export function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A `races` row as read by the T-minus workflows. */
export interface RaceRow {
  id: string | number;
  off_time: string | null;
  course: string | null;
  race_name: string | null;
  status: string | null;
}

interface RunRow {
  id: string | number;
  run_time: string | null;
  is_current: boolean | null;
  config_json: unknown;
  market_snapshot_id: string | number | null;
}

interface ScoreRow {
  runner_id: string | number;
  market_prob: number | string | null;
  model_prob: number | string | null;
  ev_per_1: number | string | null;
  rank_in_race: number | null;
}

/** Sort key for off_time: known instants ascending, unknowns last. */
function offTimeSortKey(offTime: string | null): number {
  if (!offTime) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(offTime);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * Fetches the meeting day's races (optionally one course, matched via
 * `normalizeCourse` so "Ascot" matches "Royal Ascot"), sorted by off time
 * (unknown offs last). Read-only.
 */
export async function fetchMeetingRaces(
  date: string,
  course?: string | null,
): Promise<RaceRow[]> {
  const { data: raceData, error: raceError } = await supabaseAdmin
    .from(RACES_TABLE)
    .select('id, off_time, course, race_name, status')
    .eq(RACE_MEETING_DATE_COLUMN, date);
  if (raceError) {
    throw new Error(`Failed to read races for ${date}: ${raceError.message}`);
  }

  let races = (raceData ?? []) as RaceRow[];
  const wantCourse = course ? normalizeCourse(course) : null;
  if (wantCourse) {
    races = races.filter((r) => normalizeCourse(r.course ?? '') === wantCourse);
  }
  races.sort((a, b) => offTimeSortKey(a.off_time) - offTimeSortKey(b.off_time));
  return races;
}

/** Builds one race's T-minus capture from stored history. Read-only; never writes. */
export async function buildRaceCapture(
  race: RaceRow,
  minutesBefore: number,
): Promise<TMinusRaceCapture> {
  const raceId = String(race.id);
  const offTime = race.off_time;

  const base: TMinusRaceCapture = {
    race_id: raceId,
    race_name: race.race_name,
    course: race.course,
    off_time: offTime,
    capture_target_time: null,
    selected_run_id: null,
    selected_run_time: null,
    selected_run_is_current: null,
    later_pre_off_run_exists: false,
    post_off_run_count: 0,
    pick: null,
    favourite: null,
    alternatives: [],
    run_quality: null,
    data_quality_flags: [],
    data_quality_short_summary: null,
    tipster_short_summary: null,
    tipster_alignment_label: null,
  };

  // All runs for the race (append-only history). Read-only.
  const { data: runData, error: runError } = await supabaseAdmin
    .from(MODEL_RUNS_TABLE)
    .select('id, run_time, is_current, config_json, market_snapshot_id')
    .eq('race_id', raceId)
    .order('run_time', { ascending: true });
  if (runError) {
    throw new Error(`Failed to read model runs for race ${raceId}: ${runError.message}`);
  }
  const runs = (runData ?? []) as RunRow[];

  // T-minus selection (reuses selectPreOffRun with the capture-target cutoff).
  const selection = selectTMinusRun(
    runs.map((r) => ({ run_id: String(r.id), run_time: String(r.run_time) })),
    offTime,
    minutesBefore,
  );
  base.capture_target_time = selection.captureTargetTime;
  base.later_pre_off_run_exists = selection.laterPreOffRunExists;
  base.post_off_run_count = selection.postOffRunCount;

  if (!selection.selectedRunId) {
    return base; // No capture run available; warnings will flag it.
  }
  const selected = runs.find((r) => String(r.id) === selection.selectedRunId) as RunRow;
  base.selected_run_id = selection.selectedRunId;
  base.selected_run_time = selected.run_time;
  base.selected_run_is_current = selected.is_current === true;

  // Observability from the selected run's config_json (null-safe readers).
  const dq = getDataQualityOutputsFromConfig(selected.config_json);
  const consensus = getTipsterConsensusSummaryFromConfig(selected.config_json);
  const alignment = getTipsterModelAlignmentFromConfig(selected.config_json);
  base.run_quality = dq.run_quality;
  base.data_quality_short_summary = dq.data_quality_short_summary;
  base.tipster_short_summary = consensus.short_summary;
  base.tipster_alignment_label =
    alignment && typeof alignment.alignment_label === 'string'
      ? alignment.alignment_label
      : null;

  // data_quality_flags live on the run row itself (jsonb array), read-only.
  const { data: flagRow } = await supabaseAdmin
    .from(MODEL_RUNS_TABLE)
    .select('data_quality_flags')
    .eq('id', selection.selectedRunId)
    .limit(1)
    .maybeSingle();
  const flags = (flagRow as { data_quality_flags?: unknown } | null)?.data_quality_flags;
  base.data_quality_flags = Array.isArray(flags)
    ? flags.filter((f): f is string => typeof f === 'string')
    : [];

  // Per-runner names, scores, the rank-1 rec, and the run's stored quote odds.
  const [namesRes, scoresRes, recRes, quotesRes] = await Promise.all([
    supabaseAdmin.from(RUNNERS_TABLE).select('id, horse_name').eq('race_id', raceId),
    supabaseAdmin
      .from(MODEL_RUNNER_SCORES_TABLE)
      .select('runner_id, market_prob, model_prob, ev_per_1, rank_in_race')
      .eq('model_run_id', selection.selectedRunId),
    supabaseAdmin
      .from(RECOMMENDATIONS_TABLE)
      .select('runner_id, recommendation_rank, confidence_label, stake_amount, odds, ev')
      .eq('model_run_id', selection.selectedRunId)
      .eq('recommendation_rank', 1)
      .limit(1),
    selected.market_snapshot_id != null
      ? supabaseAdmin
          .from(RUNNER_QUOTES_TABLE)
          .select('runner_id, odds_decimal')
          .eq('snapshot_id', selected.market_snapshot_id)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const res of [namesRes, scoresRes, recRes, quotesRes]) {
    if (res.error) {
      throw new Error(`Failed to read capture data for race ${raceId}: ${res.error.message}`);
    }
  }

  const nameById = new Map<string, string>();
  for (const r of (namesRes.data ?? []) as { id: string | number; horse_name: string }[]) {
    nameById.set(String(r.id), r.horse_name);
  }
  // First stored quote per runner (deterministic); odds_decimal is the priced odds.
  const oddsById = new Map<string, number | null>();
  for (const q of (quotesRes.data ?? []) as {
    runner_id: string | number;
    odds_decimal: number | string | null;
  }[]) {
    const id = String(q.runner_id);
    if (!oddsById.has(id)) oddsById.set(id, toNumberOrNull(q.odds_decimal));
  }

  const scores = (scoresRes.data ?? []) as ScoreRow[];

  const toRunner = (s: ScoreRow): TMinusRunner => {
    const id = String(s.runner_id);
    return {
      horse_name: nameById.get(id) ?? '(unknown)',
      odds: oddsById.get(id) ?? null,
      ev: toNumberOrNull(s.ev_per_1),
      model_prob: toNumberOrNull(s.model_prob),
      market_prob: toNumberOrNull(s.market_prob),
    };
  };

  // Market favourite = highest stored market_prob (deterministic tie-break by id).
  const favourite = scores.reduce<ScoreRow | null>((best, s) => {
    const p = toNumberOrNull(s.market_prob);
    if (p === null) return best;
    const bp = best ? toNumberOrNull(best.market_prob) : null;
    if (bp === null || p > bp || (p === bp && String(s.runner_id) < String(best!.runner_id))) {
      return s;
    }
    return best;
  }, null);
  base.favourite = favourite ? toRunner(favourite) : null;

  // Rank-1 recommendation -> the pick (null => no-bet). Odds/EV/stake from the
  // stored recommendation; falls back to the runner's score for EV/odds.
  const rec = ((recRes.data ?? []) as {
    runner_id: string | number;
    confidence_label: string | null;
    stake_amount: number | string | null;
    odds: number | string | null;
    ev: number | string | null;
  }[])[0];
  let pickId: string | null = null;
  if (rec) {
    const id = String(rec.runner_id);
    pickId = id;
    const score = scores.find((s) => String(s.runner_id) === id);
    base.pick = {
      runner_id: id,
      horse_name: nameById.get(id) ?? '(unknown)',
      odds: toNumberOrNull(rec.odds) ?? oddsById.get(id) ?? null,
      ev: toNumberOrNull(rec.ev) ?? (score ? toNumberOrNull(score.ev_per_1) : null),
      model_prob: score ? toNumberOrNull(score.model_prob) : null,
      market_prob: score ? toNumberOrNull(score.market_prob) : null,
      stake: toNumberOrNull(rec.stake_amount),
      confidence_label: rec.confidence_label ?? null,
    };
  }

  // Alternatives = EV ranks 2-3, excluding the pick. Deterministic by rank.
  base.alternatives = scores
    .filter((s) => s.rank_in_race != null && s.rank_in_race >= 2 && s.rank_in_race <= 3)
    .filter((s) => String(s.runner_id) !== (pickId ?? ''))
    .sort((a, b) => (a.rank_in_race ?? 0) - (b.rank_in_race ?? 0))
    .map(toRunner);

  return base;
}
