/**
 * placeAuditView — a PURE, client-safe adapter that turns the dashboard's
 * read-only race cards into the compact "Place / each-way audit" research view.
 *
 * It is a thin wrapper around {@link src/lib/placeAudit}: it maps a minimal
 * card-like shape to the audit inputs, then reuses the existing pure counting
 * helpers (`buildPlaceAuditRace` + `buildPlaceAuditSummary`) so there is a SINGLE
 * source of the placed / won counting logic. No new model, staking, ranking,
 * recommendation, payout, or result logic lives here.
 *
 * RESEARCH / DECISION-SUPPORT ONLY. The place marker is a SIMULATED top-N
 * finishing position — NOT real bookmaker each-way terms — and nothing here
 * computes a payout or profit/loss. There is NO I/O: no DB, no network, no
 * writes. Given the same cards it returns the same view, so it is fully
 * unit-testable without a database. Missing finishing positions are handled
 * safely (treated as not-placed) and the panel renders "—" / "unknown".
 */

import {
  DEFAULT_PLACES,
  NOT_ADVICE_WARNING,
  NO_PAYOUT_WARNING,
  PLACE_SIMULATED_WARNING,
  buildPlaceAuditRace,
  buildPlaceAuditSummary,
  clampPlaces,
  type AuditRunner,
  type PlaceAuditRaceInput,
  type PlaceAuditSummary,
} from '@/lib/placeAudit';

/** A runner as carried by a dashboard card (only the fields the audit needs). */
export interface PlaceAuditCardRunner {
  runner_id: string;
  horse_name: string;
  finish_pos?: number | null;
}

/** A minimal read-only race card shape (a subset of the dashboard `RaceCard`). */
export interface PlaceAuditCard {
  race_id: string;
  off_time?: string | null;
  race_name?: string | null;
  course?: string | null;
  modelPick: PlaceAuditCardRunner | null;
  favourite: PlaceAuditCardRunner | null;
  alternatives: PlaceAuditCardRunner[];
  /** Full scored field (source of the winner + race size); optional/back-compat. */
  runners?: PlaceAuditCardRunner[];
  /** Race row status (e.g. 'result' once settled). */
  status?: string | null;
  /** Model pick confidence band (e.g. 'High' / 'Medium' / 'Low'). */
  confidenceLabel?: string | null;
  /** Data-quality verdict (e.g. 'OK' / 'DEGRADED' / 'STALE'). */
  runQuality?: string | null;
}

export interface PlaceAuditViewOptions {
  /** Simulated number of places (top-N marker); defaults to {@link DEFAULT_PLACES}. */
  places?: number | null;
}

/** The compact, display-ready research view for one race day. */
export interface PlaceAuditView {
  /** e.g. "Research top-4 marker" — shown when the place terms are simulated. */
  placeMarkerLabel: string;
  /** The clamped, simulated place count actually used. */
  places: number;
  raceCount: number;
  settledRaceCount: number;
  /** True once at least one race on the day has a recorded result. */
  hasSettledRaces: boolean;
  /** The aggregated placed / won counts (single source: `buildPlaceAuditSummary`). */
  summary: PlaceAuditSummary;
  /** The always-shown research disclaimers (simulated terms / not advice / no payout). */
  warnings: string[];
}

/** The default label when the (simulated) place terms are unknown. */
export const DEFAULT_PLACE_MARKER_LABEL = `Research top-${DEFAULT_PLACES} marker`;

/** Builds the "Research top-N marker" label for a (clamped) place count. */
export function researchPlaceMarkerLabel(places: number | null | undefined): string {
  return `Research top-${clampPlaces(places)} marker`;
}

/** Maps a nullable card runner to the audit runner shape (null-safe). */
function toAuditRunner(runner: PlaceAuditCardRunner | null | undefined): AuditRunner | null {
  if (!runner) return null;
  return {
    runner_id: runner.runner_id,
    horse_name: runner.horse_name,
    finish_pos: runner.finish_pos ?? null,
  };
}

/** Maps a non-null card runner to the audit runner shape. */
function toAuditRunnerStrict(runner: PlaceAuditCardRunner): AuditRunner {
  return {
    runner_id: runner.runner_id,
    horse_name: runner.horse_name,
    finish_pos: runner.finish_pos ?? null,
  };
}

/** Maps a dashboard card to a read-only place-audit input. */
function toAuditInput(card: PlaceAuditCard): PlaceAuditRaceInput {
  return {
    race_id: card.race_id,
    off_time: card.off_time ?? null,
    race_name: card.race_name ?? null,
    course: card.course ?? null,
    modelPick: toAuditRunner(card.modelPick),
    favourite: toAuditRunner(card.favourite),
    alternatives: (card.alternatives ?? []).map(toAuditRunnerStrict),
    runners: (card.runners ?? []).map(toAuditRunnerStrict),
    confidenceLabel: card.confidenceLabel ?? null,
    runQuality: card.runQuality ?? null,
    status: card.status ?? null,
  };
}

/**
 * Builds the compact place / each-way research view from the day's read-only
 * cards. Pure + deterministic: it reuses the existing audit helpers so the
 * placed / won counts match the CLI `place:audit` report exactly.
 */
export function buildPlaceAuditView(
  cards: readonly PlaceAuditCard[],
  options?: PlaceAuditViewOptions,
): PlaceAuditView {
  const places = clampPlaces(options?.places ?? null);
  const races = cards.map((card) => buildPlaceAuditRace(toAuditInput(card), { places }));
  const summary = buildPlaceAuditSummary(races);

  return {
    placeMarkerLabel: researchPlaceMarkerLabel(places),
    places,
    raceCount: summary.raceCount,
    settledRaceCount: summary.settledRaceCount,
    hasSettledRaces: summary.settledRaceCount > 0,
    summary,
    warnings: [PLACE_SIMULATED_WARNING, NOT_ADVICE_WARNING, NO_PAYOUT_WARNING],
  };
}
