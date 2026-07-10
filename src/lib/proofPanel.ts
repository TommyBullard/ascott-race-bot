/**
 * Pure, client-safe view-model for the read-only "Proof of Update" dashboard
 * panel (src/components/ProofOfUpdatePanel.tsx).
 *
 * Given the already-loaded race-day cards (and optional server-provided audit
 * signals), this derives an at-a-glance proof of WHEN each stage last refreshed:
 * racecards, runners, odds, model, pre-off capture, results (+ source / blocked
 * reason), training capture, and GenAI commentary status, plus a pointer to the
 * durable `proof:day` report.
 *
 * READ-ONLY + HONEST. There is NO I/O here (no DB, no network, no writes); the
 * page supplies the inputs. Missing data renders as "unknown" / "not available"
 * and never implies success. It changes no model / recommendation / staking
 * logic, exposes no secret, and is never betting advice. Deterministic given its
 * inputs (and `now`).
 */

import { formatRelativeAge, isStaleAge } from './relativeTime';
import { STALE_ODDS_THRESHOLD_MS } from './modelDataQuality';
import { buildProofPath } from './proofDay';
import {
  summarizeLockCoverage,
  formatLockCoverageValue,
  lockCoverageTone,
  type RaceLockStatus,
} from './lockCoverage';

/** Tone hint for rendering (never a value judgement about a selection). */
export type ProofTone = 'ok' | 'warn' | 'neutral';

/** The recognised result-settlement sources. */
export type ResultsSource = 'standard' | 'today_basic' | 'today_free' | 'csv' | 'unknown';

/** GenAI commentary live status (the live generator is OFF by default). */
export type GenaiStatus = 'not_configured' | 'no_reviewed_notes' | 'generated';

/** Per-race read-only signals (mapped from a dashboard RaceCard). */
export interface ProofPanelRaceInput {
  offTime: string | null;
  fieldSize: number;
  latestOddsSnapshotTime: string | null;
  latestModelRunTime: string | null;
  hasModelRun: boolean;
  status: string | null;
  finishPosAvailable: boolean;
  /**
   * Live official T-minus lock status for this race (Phase 6A), derived by the
   * page via `deriveRaceLockStatus`. Optional for back-compat: when absent the
   * locks row is omitted entirely (never guessed).
   */
  lockStatus?: RaceLockStatus | null;
}

/** Everything the panel needs. Audit-only fields are optional => "unknown". */
export interface ProofPanelInput {
  date: string | null;
  course: string | null;
  /** Reference time for fresh/stale + pending (passed in; deterministic). */
  now: number;
  races: ProofPanelRaceInput[];
  /** Total stored runners, or null when not known. */
  runnersCount: number | null;
  /** Settlement source, when surfaced by the server (else "unknown"). */
  resultsSource?: ResultsSource;
  /**
   * Explicit results-blocked reason from the server. `undefined` => derive a
   * heuristic hint from unsettled past-off races; `null` => no block.
   */
  resultsBlockedReason?: string | null;
  /** ml_training_examples availability + count (undefined => not available). */
  trainingCapture?: { available: boolean; count: number | null };
  /** GenAI commentary status (undefined => not configured). */
  genai?: { status: GenaiStatus };
  /** Explicit proof report path (else derived from date + course). */
  proofReportPath?: string | null;
}

/** One labelled proof row. */
export interface ProofPanelRow {
  label: string;
  value: string;
  tone: ProofTone;
}

/** The full panel view-model. */
export interface ProofPanelView {
  title: string;
  rows: ProofPanelRow[];
  disclaimers: string[];
}

/** Fixed, always-shown disclaimers (read-only / shadow-only / no guarantee). */
export const PROOF_PANEL_DISCLAIMERS: readonly string[] = [
  'Read-only — this panel never changes anything and never places bets.',
  'GenAI commentary, if shown, is explanatory only — it never affects the model, recommendations, or staking.',
  'No guarantee — this shows when data last refreshed, not any race outcome.',
];

/** The two documented results-blocked messages. */
export const RESULTS_BLOCKED_STANDARD = 'Standard Plan required';
export const RESULTS_BLOCKED_CSV = 'manual CSV fallback required';

const RESULTS_SOURCE_LABEL: Record<ResultsSource, string> = {
  standard: 'standard (SP/BSP)',
  today_basic: 'today_basic',
  today_free: 'today_free',
  csv: 'csv',
  unknown: 'unknown',
};

const GENAI_LABEL: Record<GenaiStatus, string> = {
  not_configured: 'not configured (shadow-only)',
  no_reviewed_notes: 'no reviewed notes (shadow-only)',
  generated: 'generated (shadow-only, pending review)',
};

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Latest non-null ISO time across races for a selector. Pure. */
function latestTime(
  races: readonly ProofPanelRaceInput[],
  pick: (r: ProofPanelRaceInput) => string | null,
): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const r of races) {
    const ms = toMs(pick(r));
    if (ms !== null && ms > bestMs) {
      bestMs = ms;
      best = pick(r);
    }
  }
  return best;
}

/** A race is "captured" pre-off when a model run exists at/before its off time. */
function isPreOffCaptured(r: ProofPanelRaceInput): boolean {
  if (!r.hasModelRun || !r.latestModelRunTime) return false;
  const run = toMs(r.latestModelRunTime);
  const off = toMs(r.offTime);
  if (run === null) return false;
  return off === null ? true : run <= off;
}

/** A race is settled when its status is 'result' or a finish position exists. */
function isSettled(r: ProofPanelRaceInput): boolean {
  return r.status === 'result' || r.finishPosAvailable;
}

/**
 * Derives the results-blocked reason: an explicit server reason wins; otherwise a
 * heuristic — any past-off race that is not yet settled suggests the manual CSV
 * fallback may be needed. Returns null when nothing is blocked. Pure.
 */
export function deriveResultsBlocked(input: ProofPanelInput): string | null {
  if (input.resultsBlockedReason !== undefined) return input.resultsBlockedReason;
  const anyPendingPastOff = input.races.some((r) => {
    if (isSettled(r)) return false;
    const off = toMs(r.offTime);
    return off !== null && input.now > off;
  });
  return anyPendingPastOff ? `${RESULTS_BLOCKED_CSV} (results pending)` : null;
}

/** Resolves the proof report path (explicit, else derived from date+course). Pure. */
export function resolveProofReportPath(input: ProofPanelInput): string | null {
  if (input.proofReportPath !== undefined) return input.proofReportPath;
  return input.date ? buildProofPath(input.date, input.course) : null;
}

/**
 * Builds the deterministic proof-panel view-model. Null-safe: missing data yields
 * "unknown" / "not available" rows (never implies success). Pure.
 */
export function buildProofPanelView(input: ProofPanelInput | null): ProofPanelView {
  const rows: ProofPanelRow[] = [];
  if (!input) {
    return {
      title: 'Proof of update',
      rows: [{ label: 'Status', value: 'not available', tone: 'neutral' }],
      disclaimers: [...PROOF_PANEL_DISCLAIMERS],
    };
  }

  const races = input.races;
  const racecardsLoaded = races.length > 0;
  rows.push({
    label: 'Racecards loaded',
    value: racecardsLoaded ? 'yes' : 'no',
    tone: racecardsLoaded ? 'ok' : 'warn',
  });
  rows.push({ label: 'Races', value: String(races.length), tone: racecardsLoaded ? 'neutral' : 'warn' });

  const runners = input.runnersCount;
  rows.push({
    label: 'Runners',
    value: runners === null ? 'unknown' : String(runners),
    tone: runners && runners > 0 ? 'neutral' : 'warn',
  });

  // Odds last updated.
  const odds = latestTime(races, (r) => r.latestOddsSnapshotTime);
  if (odds) {
    const stale = isStaleAge(odds, input.now, STALE_ODDS_THRESHOLD_MS);
    rows.push({
      label: 'Odds last updated',
      value: `${formatRelativeAge(odds, input.now).text}${stale ? ' · stale' : ''}`,
      tone: stale ? 'warn' : 'ok',
    });
  } else {
    rows.push({ label: 'Odds last updated', value: 'unknown', tone: 'warn' });
  }

  // Model last updated.
  const model = latestTime(races, (r) => r.latestModelRunTime);
  rows.push(
    model
      ? { label: 'Model last updated', value: formatRelativeAge(model, input.now).text, tone: 'ok' }
      : { label: 'Model last updated', value: 'unknown', tone: 'warn' },
  );

  // T-minus capture status (pre-off runs captured / total).
  const captured = races.filter(isPreOffCaptured).length;
  rows.push({
    label: 'T-minus capture',
    value: racecardsLoaded ? `${captured}/${races.length} pre-off captured` : 'unknown',
    tone: racecardsLoaded && captured === races.length && races.length > 0 ? 'ok' : 'warn',
  });

  // Official T-minus-5 lock coverage (Phase 6A). Only rendered when the page
  // supplied per-race lock statuses; a missing signal is omitted, never guessed.
  const lockStatuses = races
    .map((r) => r.lockStatus)
    .filter((s): s is RaceLockStatus => typeof s === 'string');
  if (racecardsLoaded && lockStatuses.length === races.length) {
    const coverage = summarizeLockCoverage(lockStatuses);
    rows.push({
      label: 'Official T-minus-5 locks',
      value: formatLockCoverageValue(coverage),
      tone: lockCoverageTone(coverage),
    });
  }

  // Results status.
  const settled = races.filter(isSettled).length;
  rows.push({
    label: 'Results',
    value: racecardsLoaded ? `${settled}/${races.length} settled` : 'no results yet',
    tone: racecardsLoaded && settled === races.length && races.length > 0 ? 'ok' : 'neutral',
  });

  // Results source.
  const source: ResultsSource = input.resultsSource ?? 'unknown';
  rows.push({
    label: 'Results source',
    value: RESULTS_SOURCE_LABEL[source],
    tone: source === 'unknown' ? 'neutral' : 'ok',
  });

  // Results blocked reason (only meaningful when present).
  const blocked = deriveResultsBlocked(input);
  rows.push({
    label: 'Results blocked',
    value: blocked ?? 'none',
    tone: blocked ? 'warn' : 'ok',
  });

  // Training capture status.
  if (!input.trainingCapture) {
    rows.push({ label: 'Training capture', value: 'not available', tone: 'neutral' });
  } else if (!input.trainingCapture.available) {
    rows.push({ label: 'Training capture', value: 'table missing (migration needed)', tone: 'warn' });
  } else {
    const n = input.trainingCapture.count;
    rows.push({
      label: 'Training capture',
      value: n === null ? 'present (count unavailable)' : `${n} rows`,
      tone: 'neutral',
    });
  }

  // GenAI commentary status (always shadow-only).
  const genai: GenaiStatus = input.genai?.status ?? 'not_configured';
  rows.push({ label: 'GenAI commentary', value: GENAI_LABEL[genai], tone: 'neutral' });

  // Last proof report path.
  const proofPath = resolveProofReportPath(input);
  rows.push({
    label: 'Proof report',
    value: proofPath ?? 'not available',
    tone: 'neutral',
  });

  return { title: 'Proof of update', rows, disclaimers: [...PROOF_PANEL_DISCLAIMERS] };
}
