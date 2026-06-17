/**
 * Pure helpers for the read-only "no-bet gate research audit"
 * (scripts/noBetGateAudit.ts). Phase 6 of the autonomous race-day workflow.
 *
 * This module SIMULATES candidate skip / no-bet rules against the model's
 * historical FINAL PRE-OFF recommendations and reports what WOULD have happened
 * (which races each gate would have skipped, and the resulting P/L). It is
 * RESEARCH ONLY: it never changes a live recommendation, never activates a gate,
 * never suppresses a real model output, and never claims improved future
 * accuracy. A single day of seven races is far too small to approve any gate.
 *
 * Everything here is pure and deterministic: the gate definitions, the matching,
 * the simulation maths (which REUSE the shared `summarizeModelPerformance`), the
 * summaries, and the Markdown rendering. There is no database access, no network,
 * and no mutation. Nothing is fabricated: missing values render as an em dash and
 * underivable signals are treated conservatively (a gate never skips on an
 * unknown condition).
 */

import {
  summarizeModelPerformance,
  type RecommendationOutcome,
} from './modelPerformance';
import { LARGE_FIELD_SIZE } from './confidenceDiagnostics';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DASH = '\u2014';

/**
 * Minimum settled bets before a gate could even be CONSIDERED for promotion.
 * Deliberately large: a single race day is research signal only, never approval.
 */
export const MIN_SAMPLE_FOR_PROMOTION = 100;

/* -------------------------------------------------------------------------- */
/* Arguments + output path                                                    */
/* -------------------------------------------------------------------------- */

/** Parsed CLI options for the gate audit. */
export interface GateAuditArgs {
  date?: string;
  course?: string;
}

/** Parses argv (sliced past `node script`). `--date` strict YYYY-MM-DD. Pure. */
export function parseGateAuditArgs(argv: readonly string[]): GateAuditArgs {
  const args: GateAuditArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') {
      const value = (argv[++i] ?? '').trim();
      if (DATE_RE.test(value)) args.date = value;
    } else if (a === '--course') {
      const value = (argv[++i] ?? '').trim();
      if (value !== '') args.course = value;
    }
  }
  return args;
}

/** Builds `reports/no-bet-gate-audit-<date>[-<course-slug>].md`. Pure. */
export function buildGateAuditPath(date: string, course?: string | null): string {
  const slug = (course ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `reports/no-bet-gate-audit-${date}-${slug}.md` : `reports/no-bet-gate-audit-${date}.md`;
}

/* -------------------------------------------------------------------------- */
/* Per-race input (resolved by the script from stored metadata)               */
/* -------------------------------------------------------------------------- */

/** One race's stored signals + outcome, the unit a gate reasons about. */
export interface GateRaceInput {
  race_id: string;
  off_time: string | null;
  race_name: string | null;
  model_pick_name: string | null;
  /** The model's ORIGINAL confidence label (read-only; never changed). */
  confidence_label: string | null;
  /** Run-quality verdict (OK / DEGRADED / STALE / INVALID), or null. */
  run_quality: string | null;
  /** Tipster/model alignment label, or null. */
  tipster_alignment_label: string | null;
  /** Field size, or null. */
  field_size: number | null;
  /** Whether many runners share a near-identical EV, or null. */
  similar_ev: boolean | null;
  /** Whether the diagnostic race_type_confidence was low, or null. */
  race_type_confidence_low: boolean | null;
  /** Whether the selected pre-off run made a rank-1 recommendation (a bet). */
  has_pick: boolean;
  /** Whether the race has an official result. */
  has_result: boolean;
  /** Whether the pick won (finished 1st). Only meaningful when settled. */
  won: boolean;
  /** Stored pick odds / stake / EV, or null. */
  odds: number | null;
  stake: number | null;
  ev: number | null;
  /** The winning runner name, or null. */
  winner_name: string | null;
}

/* -------------------------------------------------------------------------- */
/* Gate definitions + matching (pure)                                         */
/* -------------------------------------------------------------------------- */

const isLow = (r: GateRaceInput): boolean =>
  (r.confidence_label ?? '').trim().toLowerCase() === 'low';
const isDivergent = (r: GateRaceInput): boolean => r.tipster_alignment_label === 'DIVERGENT';
const isNoConsensus = (r: GateRaceInput): boolean => r.tipster_alignment_label === 'NO_TIPSTER_CONSENSUS';
const isDegraded = (r: GateRaceInput): boolean => r.run_quality === 'DEGRADED';
const isLargeField = (r: GateRaceInput): boolean => r.field_size != null && r.field_size >= LARGE_FIELD_SIZE;
const isSimilarEv = (r: GateRaceInput): boolean => r.similar_ev === true;
const isRaceTypeLow = (r: GateRaceInput): boolean => r.race_type_confidence_low === true;

/** A candidate no-bet gate: an id, a human description, and a skip predicate. */
export interface GateDefinition {
  id: string;
  name: string;
  description: string;
  /** True when this gate WOULD skip the race (research only; never enforced). */
  matches: (race: GateRaceInput) => boolean;
}

/**
 * The candidate gates to simulate, in a fixed order for determinism. Every gate
 * is conservative: it can only skip on conditions that are POSITIVELY present
 * (an unknown condition never triggers a skip), so nothing is fabricated.
 */
export const GATE_DEFINITIONS: readonly GateDefinition[] = [
  {
    id: 'low_only',
    name: 'LOW confidence only',
    description: 'Skip when the original confidence label is LOW.',
    matches: (r) => isLow(r),
  },
  {
    id: 'low_divergent',
    name: 'LOW + DIVERGENT tipsters',
    description: 'Skip when LOW confidence and tipsters are DIVERGENT.',
    matches: (r) => isLow(r) && isDivergent(r),
  },
  {
    id: 'low_no_consensus',
    name: 'LOW + NO_TIPSTER_CONSENSUS',
    description: 'Skip when LOW confidence and there is no tipster consensus.',
    matches: (r) => isLow(r) && isNoConsensus(r),
  },
  {
    id: 'low_degraded',
    name: 'LOW + DEGRADED data quality',
    description: 'Skip when LOW confidence and data quality is DEGRADED.',
    matches: (r) => isLow(r) && isDegraded(r),
  },
  {
    id: 'degraded_divergent',
    name: 'DEGRADED + DIVERGENT',
    description: 'Skip when data quality is DEGRADED and tipsters are DIVERGENT.',
    matches: (r) => isDegraded(r) && isDivergent(r),
  },
  {
    id: 'low_divergent_or_no_consensus',
    name: 'LOW + DIVERGENT/NO_TIPSTER_CONSENSUS',
    description: 'Skip when LOW confidence and tipsters are DIVERGENT or have no consensus.',
    matches: (r) => isLow(r) && (isDivergent(r) || isNoConsensus(r)),
  },
  {
    id: 'low_large_field',
    name: 'LOW + large field',
    description: `Skip when LOW confidence and the field is large (>= ${LARGE_FIELD_SIZE} runners).`,
    matches: (r) => isLow(r) && isLargeField(r),
  },
  {
    id: 'low_similar_ev',
    name: 'LOW + similar-EV cluster',
    description: 'Skip when LOW confidence and many runners share a near-identical EV.',
    matches: (r) => isLow(r) && isSimilarEv(r),
  },
  {
    id: 'low_race_type_low',
    name: 'LOW + low race-type confidence',
    description: 'Skip when LOW confidence and the diagnostic race-type confidence is low.',
    matches: (r) => isLow(r) && isRaceTypeLow(r),
  },
  {
    id: 'strict_caution',
    name: 'Strict caution',
    description: 'Skip when LOW confidence AND (DIVERGENT OR NO_TIPSTER_CONSENSUS OR DEGRADED).',
    matches: (r) => isLow(r) && (isDivergent(r) || isNoConsensus(r) || isDegraded(r)),
  },
];

/**
 * The ids of the gates that would skip a given race. A race with no pick has no
 * bet to skip, so it always returns `[]`. Deterministic (GATE_DEFINITIONS order).
 * Pure.
 */
export function gatesSkippingRace(race: GateRaceInput): string[] {
  if (!race.has_pick) return [];
  return GATE_DEFINITIONS.filter((g) => g.matches(race)).map((g) => g.id);
}

/* -------------------------------------------------------------------------- */
/* Simulation (reuses summarizeModelPerformance)                              */
/* -------------------------------------------------------------------------- */

function toOutcome(r: GateRaceInput): RecommendationOutcome {
  return { settled: r.has_result, won: r.won, odds: r.odds, stake: r.stake, ev: r.ev };
}

/** The result of simulating one gate over the betting races. */
export interface GateSimulationResult {
  gate_id: string;
  gate_name: string;
  description: string;
  races_skipped: number;
  races_kept: number;
  winners_skipped: number;
  losers_skipped: number;
  winners_kept: number;
  losers_kept: number;
  original_staked: number;
  remaining_staked: number;
  original_pl: number;
  simulated_pl: number;
  original_roi: number;
  simulated_roi: number;
  /** simulated_pl − original_pl. Positive = better on THIS sample only. */
  pl_delta: number;
  /** Verdict for THIS sample only — never a promotion signal. */
  verdict: 'improved' | 'worsened' | 'neutral';
  /** True when the settled sample is below {@link MIN_SAMPLE_FOR_PROMOTION}. */
  sample_too_small: boolean;
}

/**
 * Simulates one gate: removes the races it would skip and recomputes P/L via the
 * shared {@link summarizeModelPerformance}. Skipped races are EXCLUDED from the
 * simulated P/L. Pure; never throws; never mutates.
 */
export function buildGateSimulation(
  gate: GateDefinition,
  picks: readonly GateRaceInput[],
): GateSimulationResult {
  const skipped = picks.filter((p) => gate.matches(p));
  const kept = picks.filter((p) => !gate.matches(p));

  const original = summarizeModelPerformance(picks.map(toOutcome));
  const simulated = summarizeModelPerformance(kept.map(toOutcome));

  const settledWon = (r: GateRaceInput): boolean => r.has_result && r.won;
  const settledLost = (r: GateRaceInput): boolean => r.has_result && !r.won;

  const pl_delta = simulated.profit_loss - original.profit_loss;

  return {
    gate_id: gate.id,
    gate_name: gate.name,
    description: gate.description,
    races_skipped: skipped.length,
    races_kept: kept.length,
    winners_skipped: skipped.filter(settledWon).length,
    losers_skipped: skipped.filter(settledLost).length,
    winners_kept: kept.filter(settledWon).length,
    losers_kept: kept.filter(settledLost).length,
    original_staked: original.total_staked,
    remaining_staked: simulated.total_staked,
    original_pl: original.profit_loss,
    simulated_pl: simulated.profit_loss,
    original_roi: original.roi,
    simulated_roi: simulated.roi,
    pl_delta,
    verdict: pl_delta > 0 ? 'improved' : pl_delta < 0 ? 'worsened' : 'neutral',
    sample_too_small: original.settled_count < MIN_SAMPLE_FOR_PROMOTION,
  };
}

/** Simulates every gate over the betting races (has_pick only). Pure. */
export function buildAllGateSimulations(
  races: readonly GateRaceInput[],
): GateSimulationResult[] {
  const picks = races.filter((r) => r.has_pick);
  return GATE_DEFINITIONS.map((gate) => buildGateSimulation(gate, picks));
}

/* -------------------------------------------------------------------------- */
/* Markdown rendering (pure, deterministic)                                   */
/* -------------------------------------------------------------------------- */

function orDash(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return DASH;
  return String(value);
}

function fmtPoints(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  const sign = value > 0 ? '+' : value < 0 ? '\u2212' : '';
  return `${sign}${Math.abs(value).toFixed(2)}pt`;
}

function fmtPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  const sign = value > 0 ? '+' : value < 0 ? '\u2212' : '';
  return `${sign}${Math.abs(value).toFixed(1)}%`;
}

function fmtNum(value: number | null, dp: number): string {
  return value === null || !Number.isFinite(value) ? DASH : value.toFixed(dp);
}

function fmtOffTimeHm(offTime: string | null): string {
  if (!offTime) return DASH;
  const ms = new Date(offTime).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 16) : DASH;
}

/** The P/L for one settled pick at stored stake/odds (via the shared maths). */
function racePnl(r: GateRaceInput): number | null {
  if (!r.has_pick || !r.has_result) return null;
  return summarizeModelPerformance([toOutcome(r)]).profit_loss;
}

/** A pick's outcome label. */
function outcomeLabel(r: GateRaceInput): string {
  if (!r.has_pick) return 'No bet';
  if (!r.has_result) return 'Pending';
  return r.won ? 'Won' : 'Lost';
}

/** The full audit payload passed to {@link renderGateAuditMarkdown}. */
export interface GateAuditReport {
  date: string;
  course: string | null;
  generatedAt: string;
  races: GateRaceInput[];
}

function renderGateSection(sim: GateSimulationResult): string {
  const lines: string[] = [];
  lines.push(`### ${sim.gate_name}`);
  lines.push('');
  lines.push(`- Rule: ${sim.description}`);
  lines.push(`- Races skipped: ${sim.races_skipped} · races kept: ${sim.races_kept}`);
  lines.push(`- Winners skipped: ${sim.winners_skipped} · losers skipped: ${sim.losers_skipped}`);
  lines.push(`- Winners kept: ${sim.winners_kept} · losers kept: ${sim.losers_kept}`);
  lines.push(`- Total staked: ${fmtNum(sim.original_staked, 2)} -> ${fmtNum(sim.remaining_staked, 2)}`);
  lines.push(`- P/L: ${fmtPoints(sim.original_pl)} -> ${fmtPoints(sim.simulated_pl)} (delta ${fmtPoints(sim.pl_delta)})`);
  lines.push(`- ROI: ${fmtPct(sim.original_roi)} -> ${fmtPct(sim.simulated_roi)}`);
  lines.push(
    `- On THIS sample only: ${sim.verdict}` +
      `${sim.sample_too_small ? ' — ⚠️ sample far too small to approve (research signal only)' : ''}`,
  );
  return lines.join('\n');
}

/**
 * Renders the full no-bet gate audit as deterministic Markdown. Pure: the same
 * report object always yields the same string. Research-only: it states plainly
 * that nothing here changes production, that one day / seven races is too small
 * to approve any gate, and that no gate may be promoted without larger
 * out-of-sample testing. Missing values render as an em dash.
 */
export function renderGateAuditMarkdown(report: GateAuditReport): string {
  const sims = buildAllGateSimulations(report.races);
  const picks = report.races.filter((r) => r.has_pick);
  const settled = picks.filter((r) => r.has_result).length;

  const blocks: string[] = [];

  blocks.push(`# No-bet gate research audit ${DASH} ${report.date}`);
  blocks.push(
    [
      `Course: ${report.course ?? 'All'}`,
      `Generated: ${report.generatedAt}`,
      `Races: ${report.races.length}`,
      `Betting races: ${picks.length}`,
    ].join('  \n'),
  );
  blocks.push(
    [
      '> RESEARCH ONLY. This SIMULATES candidate skip rules against historical',
      '> pre-off recommendations; it does NOT change live recommendations, does NOT',
      '> activate any gate, and suppresses no real model output. **One day / seven',
      "> races is far too small to approve any gate.** No gate may be promoted",
      '> without much larger OUT-OF-SAMPLE testing. No improved-accuracy claim is',
      '> made and this is not betting advice.',
    ].join('\n'),
  );

  // Gate simulations.
  const gateBlocks = ['## Candidate gate simulations'];
  if (picks.length === 0) {
    gateBlocks.push('');
    gateBlocks.push('_No betting races in scope — nothing to simulate._');
  }
  blocks.push(gateBlocks.join('\n'));
  for (const sim of sims) blocks.push(renderGateSection(sim));

  // Per-race table.
  const rows: string[] = [
    '## Per-race detail',
    '',
    '| Off | Race | Pick | Winner | Outcome | Stake | P/L | Confidence | Data quality | Tipster | Field | Gates that would skip |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  if (report.races.length === 0) {
    rows.push('| ' + `${DASH} | `.repeat(11) + `${DASH} |`);
  } else {
    for (const r of report.races) {
      const gates = gatesSkippingRace(r);
      rows.push(
        `| ${fmtOffTimeHm(r.off_time)} | ${orDash(r.race_name)} | ${orDash(r.model_pick_name)} | ` +
          `${orDash(r.winner_name)} | ${outcomeLabel(r)} | ${fmtNum(r.stake, 2)} | ${fmtPoints(racePnl(r))} | ` +
          `${orDash(r.confidence_label)} | ${orDash(r.run_quality)} | ${orDash(r.tipster_alignment_label)} | ` +
          `${orDash(r.field_size)} | ${gates.length ? gates.join(', ') : DASH} |`,
      );
    }
  }
  blocks.push(rows.join('\n'));

  // Closing caveat.
  blocks.push(
    [
      '## Interpretation',
      '',
      `- Settled betting races in scope: ${settled} (need >= ${MIN_SAMPLE_FOR_PROMOTION} settled bets before a gate could even be considered).`,
      '- Any "improved" verdict above reflects THIS tiny sample only and is not evidence of edge.',
      '- No gate is active in production, and none should be promoted without large, out-of-sample, leakage-free backtesting.',
      '- This is decision-support / research only — not betting advice, and no claim of improved future accuracy is made.',
    ].join('\n'),
  );

  return blocks.join('\n\n') + '\n';
}
