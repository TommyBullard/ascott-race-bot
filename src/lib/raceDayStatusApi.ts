/**
 * Pure builder for the READ-ONLY race-day status API (GET /api/race-day/status).
 *
 * Given an already-fetched, read-only projection of the meeting's race cards plus
 * the (pre-off) performance summary and the current clock, it assembles the
 * compact JSON status object the dashboard polls: a performance summary, the next
 * race, per-race operational state (freshness / race state / result / warnings),
 * the operator next action, and explicit safety flags.
 *
 * It REUSES the shared pure helpers (raceDayStatus / raceDayTimeline /
 * operatorNextAction / relativeTime) so the API stays consistent with the
 * dashboard. There is NO I/O here: no DB, no network, no writes, no model maths.
 * Deterministic given its inputs, so it is fully unit-testable. Pre-off
 * evaluation is preserved upstream (the cards come from `fetchRaceCard`'s pre-off
 * selection and the performance from `computeModelPerformance`'s `pre_off` mode);
 * this builder never re-selects a run.
 */

import { formatRelativeAge } from './relativeTime';
import {
  deriveRaceState,
  deriveResultStatus,
  selectNextRace,
  type RaceState,
  type ResultStatus,
} from './raceDayStatus';
import { buildRaceDayTimeline } from './raceDayTimeline';
import { deriveNextAction, type NextAction } from './operatorNextAction';

/** A runner with finishing position (read-only projection of a card runner). */
export interface StatusRunner {
  runner_id: string;
  horse_name: string;
  odds: number | null;
  finish_pos: number | null;
}

/** Read-only per-race input (a projection of the dashboard RaceCard). */
export interface StatusCardInput {
  race_id: string;
  off_time: string | null;
  race_name: string | null;
  course: string | null;
  status: string | null;
  result_time: string | null;
  oddsUpdatedAt: string | null;
  modelUpdatedAt: string | null;
  hasModelRun: boolean;
  runQuality: string | null;
  confidenceLabel: string | null;
  modelPick: StatusRunner | null;
  favourite: StatusRunner | null;
}

/** The subset of performance fields the response exposes. */
export interface PerformanceInputLike {
  recommendations_total?: number;
  settled_count?: number;
  pending_count?: number;
  winners?: number;
  losers?: number;
  profit_loss?: number;
  roi?: number;
  evaluationMode?: string;
}

export interface PerformanceSummary {
  recommendations_total: number;
  settled_count: number;
  pending_count: number;
  winners: number;
  losers: number;
  profit_loss: number;
  roi: number;
  evaluationMode: string;
}

/** A compact runner reference for the response. */
export interface CompactRunner {
  runner_id: string;
  horse_name: string;
  odds: number | null;
}

export interface FreshnessLabels {
  odds: string;
  model: string;
  results: string | null;
  odds_stale: boolean;
  model_stale: boolean;
}

export interface RaceStatusEntry {
  race_id: string;
  race_time: string | null;
  race_name: string | null;
  off_time: string | null;
  race_state: RaceState;
  odds_updated_at: string | null;
  model_updated_at: string | null;
  freshness: FreshnessLabels;
  model_pick: CompactRunner | null;
  market_favourite: CompactRunner | null;
  result_status: ResultStatus;
  settled: boolean;
  model_pick_finish_pos: number | null;
  warnings: string[];
}

export interface NextRaceSummary {
  race_id: string;
  race_time: string | null;
  race_name: string | null;
  race_state: RaceState;
  model_pick: CompactRunner | null;
  market_favourite: CompactRunner | null;
  confidence: string | null;
  data_quality: string | null;
  result_status: ResultStatus;
}

export interface SafetyFlags {
  readOnly: boolean;
  autoBetting: boolean;
  uiCommitAllowed: boolean;
}

export interface RaceDayStatusResponse {
  date: string;
  course: string | null;
  generatedAt: string;
  performance: PerformanceSummary;
  nextRace: NextRaceSummary | null;
  races: RaceStatusEntry[];
  nextAction: NextAction;
  safety: SafetyFlags;
}

export interface RaceDayStatusInput {
  date: string;
  course: string | null;
  now: number;
  cards: readonly StatusCardInput[];
  performance: PerformanceInputLike | null;
}

/**
 * Strict `YYYY-MM-DD` calendar-date validation (round-trips, so it rejects
 * `2026-13-01` / `2026-02-30` / wrong formats). The route returns 400 when this
 * is false. Pure.
 */
export function isValidIsoDate(date: string | null | undefined): boolean {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/** Compact runner projection (id + name + odds). */
function compact(runner: StatusRunner): CompactRunner {
  return { runner_id: runner.runner_id, horse_name: runner.horse_name, odds: runner.odds };
}

/** Maps the performance result (or null) to the response summary. */
function toPerformanceSummary(p: PerformanceInputLike | null): PerformanceSummary {
  return {
    recommendations_total: p?.recommendations_total ?? 0,
    settled_count: p?.settled_count ?? 0,
    pending_count: p?.pending_count ?? 0,
    winners: p?.winners ?? 0,
    losers: p?.losers ?? 0,
    profit_loss: p?.profit_loss ?? 0,
    roi: p?.roi ?? 0,
    evaluationMode: p?.evaluationMode ?? 'pre_off',
  };
}

/** Builds the next-race summary from a card. */
function buildNextRaceSummary(card: StatusCardInput, now: number): NextRaceSummary {
  const stateArgs = { offTime: card.off_time, now, status: card.status };
  return {
    race_id: card.race_id,
    race_time: card.off_time,
    race_name: card.race_name,
    race_state: deriveRaceState(stateArgs),
    model_pick: card.modelPick ? compact(card.modelPick) : null,
    market_favourite: card.favourite ? compact(card.favourite) : null,
    confidence: card.confidenceLabel,
    data_quality: card.runQuality,
    result_status: deriveResultStatus(stateArgs),
  };
}

/**
 * Assembles the full read-only race-day status response. Pure & deterministic.
 */
export function buildRaceDayStatus(input: RaceDayStatusInput): RaceDayStatusResponse {
  const { date, course, now, cards, performance } = input;

  const timeline = buildRaceDayTimeline(
    cards.map((c) => ({
      race_id: c.race_id,
      off_time: c.off_time,
      race_name: c.race_name,
      course: c.course,
      oddsUpdatedAt: c.oddsUpdatedAt,
      modelUpdatedAt: c.modelUpdatedAt,
      hasModelRun: c.hasModelRun,
      status: c.status,
      resultTime: c.result_time,
      runQuality: c.runQuality,
    })),
    now,
  );

  const cardById = new Map(cards.map((c) => [c.race_id, c]));

  const races: RaceStatusEntry[] = timeline.map((entry) => {
    const card = cardById.get(entry.race_id) ?? null;
    const settled = entry.resultStatus === 'settled';
    const modelPickFinish =
      settled && card?.modelPick ? card.modelPick.finish_pos ?? null : null;
    return {
      race_id: entry.race_id,
      race_time: entry.off_time,
      race_name: entry.race_name,
      off_time: entry.off_time,
      race_state: entry.raceState,
      odds_updated_at: entry.oddsUpdatedAt,
      model_updated_at: entry.modelUpdatedAt,
      freshness: {
        odds: formatRelativeAge(entry.oddsUpdatedAt, now).text,
        model: formatRelativeAge(entry.modelUpdatedAt, now).text,
        results: entry.settledTime ? formatRelativeAge(entry.settledTime, now).text : null,
        odds_stale: entry.oddsStale,
        model_stale: entry.modelStale,
      },
      model_pick: card?.modelPick ? compact(card.modelPick) : null,
      market_favourite: card?.favourite ? compact(card.favourite) : null,
      result_status: entry.resultStatus,
      settled,
      model_pick_finish_pos: modelPickFinish,
      warnings: entry.warnings,
    };
  });

  const nextCard = selectNextRace(cards, now);
  const nextRace = nextCard ? buildNextRaceSummary(nextCard, now) : null;

  const nextAction: NextAction = deriveNextAction(
    cards.map((c) => ({ off_time: c.off_time, status: c.status })),
    now,
    { date, course },
  );

  return {
    date,
    course,
    generatedAt: new Date(now).toISOString(),
    performance: toPerformanceSummary(performance),
    nextRace,
    races,
    nextAction,
    safety: { readOnly: true, autoBetting: false, uiCommitAllowed: false },
  };
}
