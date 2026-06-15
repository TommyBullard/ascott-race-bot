/**
 * Pure data-quality assessment for a model run.
 *
 * Detects honest, structured warnings about the inputs a run was computed from,
 * persisted on `model_runs.data_quality_flags`. No I/O — it is a deterministic
 * function of already-loaded race/runners/odds/tipster data, so it is the single
 * source of every data-quality flag (shared by the producer
 * {@link import('./runModelForRace')} via {@link import('./modelRunMetadata')}).
 *
 * INTEGRITY: never fabricates and never treats missing data as zero. A flag is
 * only emitted when the data needed to PROVE it is present — e.g. completeness
 * flags require a known declared-runner count, `STALE_ODDS` requires a known
 * snapshot age. When the relevant input is unknown (null/undefined), the
 * corresponding flag is simply not assessed (no false positive).
 */

/** Minimum fraction of declared runners that must be priced (else low completeness). */
export const MIN_MARKET_COMPLETENESS = 0.8;

/**
 * How often the odds pipeline refreshes a race's market (the `/api/cron/odds`
 * cadence, every 5 minutes). The staleness threshold is defined RELATIVE to this
 * so the two stay in sync if the polling cadence changes.
 */
export const ODDS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Latest-snapshot age (ms) beyond which odds are considered stale. Defined as
 * two refresh intervals: a single missed refresh is tolerated, but two or more
 * (the odds are older than they should ever be under normal polling) is flagged.
 */
export const STALE_ODDS_THRESHOLD_MS = 2 * ODDS_REFRESH_INTERVAL_MS;

/** Declared-runner count below which a race is flagged low (a 1-runner walkover). */
export const MIN_RUNNER_COUNT = 2;

/**
 * Every data-quality flag this module can emit. Values are the literal strings
 * stored in `model_runs.data_quality_flags`.
 */
export const DATA_QUALITY_FLAG = {
  /** No market snapshot exists for the race. */
  NO_MARKET_SNAPSHOT: 'NO_MARKET_SNAPSHOT',
  /** No runners have usable current odds. */
  NO_PRICED_RUNNERS: 'NO_PRICED_RUNNERS',
  /** At least one declared runner lacks usable current odds. */
  MISSING_RUNNER_ODDS: 'MISSING_RUNNER_ODDS',
  /** Fewer than {@link MIN_MARKET_COMPLETENESS} of declared runners are priced. */
  LOW_MARKET_COMPLETENESS: 'LOW_MARKET_COMPLETENESS',
  /** Latest odds snapshot is older than {@link STALE_ODDS_THRESHOLD_MS}. */
  STALE_ODDS: 'STALE_ODDS',
  /** Declared runner count is below {@link MIN_RUNNER_COUNT}. */
  LOW_RUNNER_COUNT: 'LOW_RUNNER_COUNT',
  /** No tipster selections were available, so the run is market-only. */
  NO_TIPSTER_SELECTIONS: 'NO_TIPSTER_SELECTIONS',
  /** Tipster selections exist but none reference a priced runner. */
  TIPSTER_SELECTIONS_UNMATCHED: 'TIPSTER_SELECTIONS_UNMATCHED',
} as const;

export type DataQualityFlag =
  (typeof DATA_QUALITY_FLAG)[keyof typeof DATA_QUALITY_FLAG];

/**
 * Severity of a data-quality flag, for display/triage. Advisory only \u2014 NOT yet
 * persisted and NOT consumed by probability/staking/selection logic.
 * - `critical` : the run is fundamentally unusable (no market to price from).
 * - `warning`  : the market is usable but degraded (partial/old pricing).
 * - `info`     : informational; the run is fine (e.g. simply market-only).
 */
export type FlagSeverity = 'critical' | 'warning' | 'info';

/**
 * Safe default severity for any flag not explicitly mapped (including unknown
 * strings). `info` is intentionally non-escalating: an uncatalogued flag is
 * surfaced without being treated as a warning/critical it may not be.
 */
export const DEFAULT_FLAG_SEVERITY: FlagSeverity = 'info';

/** Severity for each known data-quality flag. */
const FLAG_SEVERITY: Record<DataQualityFlag, FlagSeverity> = {
  [DATA_QUALITY_FLAG.NO_PRICED_RUNNERS]: 'critical',
  [DATA_QUALITY_FLAG.NO_MARKET_SNAPSHOT]: 'critical',
  [DATA_QUALITY_FLAG.LOW_MARKET_COMPLETENESS]: 'warning',
  [DATA_QUALITY_FLAG.MISSING_RUNNER_ODDS]: 'warning',
  [DATA_QUALITY_FLAG.STALE_ODDS]: 'warning',
  // Not in the original spec's list; classified `warning` as a structural market
  // concern (a near-empty field), consistent with the other completeness flags.
  [DATA_QUALITY_FLAG.LOW_RUNNER_COUNT]: 'warning',
  [DATA_QUALITY_FLAG.NO_TIPSTER_SELECTIONS]: 'info',
  [DATA_QUALITY_FLAG.TIPSTER_SELECTIONS_UNMATCHED]: 'info',
};

/**
 * Returns the severity of a data-quality flag. Accepts any string; an
 * unmapped/unknown flag falls back to {@link DEFAULT_FLAG_SEVERITY} (`info`)
 * rather than throwing, so callers are robust to new/foreign flags.
 */
export function getFlagSeverity(flag: string): FlagSeverity {
  return FLAG_SEVERITY[flag as DataQualityFlag] ?? DEFAULT_FLAG_SEVERITY;
}

/**
 * Canonical flag order. {@link assessDataQuality} evaluates flags in this order
 * so the returned array is stable and de-duplicated regardless of input.
 */
const FLAG_ORDER: DataQualityFlag[] = [
  DATA_QUALITY_FLAG.NO_MARKET_SNAPSHOT,
  DATA_QUALITY_FLAG.NO_PRICED_RUNNERS,
  DATA_QUALITY_FLAG.MISSING_RUNNER_ODDS,
  DATA_QUALITY_FLAG.LOW_MARKET_COMPLETENESS,
  DATA_QUALITY_FLAG.STALE_ODDS,
  DATA_QUALITY_FLAG.LOW_RUNNER_COUNT,
  DATA_QUALITY_FLAG.NO_TIPSTER_SELECTIONS,
  DATA_QUALITY_FLAG.TIPSTER_SELECTIONS_UNMATCHED,
];

/** Tunable thresholds (defaults to the module constants when omitted). */
export interface DataQualityConfig {
  minMarketCompleteness?: number;
  staleOddsThresholdMs?: number;
  minRunnerCount?: number;
}

/**
 * Already-loaded inputs to assess. Fields typed `... | null` are "unknown when
 * absent": the corresponding flag is NOT assessed rather than assumed.
 */
export interface DataQualityInput {
  /** Total declared runners for the race; null/undefined when unknown. */
  declaredRunnerCount?: number | null;
  /** runner_ids that have usable current odds (the priced field). */
  pricedRunnerIds: string[];
  /** Whether a market snapshot exists; undefined when unknown. */
  hasMarketSnapshot?: boolean;
  /** Age (ms) of the latest snapshot; null/undefined when unknown. */
  snapshotAgeMs?: number | null;
  /** runner_ids referenced by tipster selections (may be empty). */
  tipsterSelectionRunnerIds: string[];
}

/** True when `value` is a usable, finite number. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Computed data-quality metrics for a run, alongside the flags. Fields typed
 * `number | null` are `null` when the data needed to compute them is absent
 * (never fabricated):
 * - `market_completeness`   : priced / declared in [0, 1]; null when the
 *                             declared count is unknown or 0 (cannot divide).
 * - `declared_runner_count` : echoed declared count; null when unknown.
 * - `priced_runner_count`   : number of runners with usable odds (always known).
 * - `odds_age_ms`           : latest snapshot age in ms; null when unknown.
 */
export interface DataQualityMetrics {
  market_completeness: number | null;
  declared_runner_count: number | null;
  priced_runner_count: number;
  odds_age_ms: number | null;
}

/** The full output of {@link assessDataQuality}: detected flags + computed metrics. */
export interface DataQualityAssessment {
  flags: string[];
  metrics: DataQualityMetrics;
}

/**
 * Assesses data-quality flags AND metrics for a model run from already-loaded
 * data.
 *
 * Returns `{ flags, metrics }`: the detected flags in {@link FLAG_ORDER}
 * (stable, de-duplicated) plus the computed {@link DataQualityMetrics}. Only
 * flags/metrics whose proving data is present are produced; unknown inputs are
 * skipped (flags) or reported as `null` (metrics), never guessed.
 */
export function assessDataQuality(
  input: DataQualityInput,
  config: DataQualityConfig = {},
): DataQualityAssessment {
  const minCompleteness =
    config.minMarketCompleteness ?? MIN_MARKET_COMPLETENESS;
  const staleThresholdMs =
    config.staleOddsThresholdMs ?? STALE_ODDS_THRESHOLD_MS;
  const minRunnerCount = config.minRunnerCount ?? MIN_RUNNER_COUNT;

  const pricedCount = input.pricedRunnerIds.length;
  const declared = input.declaredRunnerCount;
  const declaredKnown = isFiniteNumber(declared) && declared > 0;

  const detected = new Set<DataQualityFlag>();

  // No market snapshot (only when explicitly known to be absent).
  if (input.hasMarketSnapshot === false) {
    detected.add(DATA_QUALITY_FLAG.NO_MARKET_SNAPSHOT);
  }

  // No priced runners.
  if (pricedCount === 0) {
    detected.add(DATA_QUALITY_FLAG.NO_PRICED_RUNNERS);
  }

  // Missing odds / low completeness need a known declared count (never assumed).
  if (declaredKnown) {
    if (pricedCount < declared) {
      detected.add(DATA_QUALITY_FLAG.MISSING_RUNNER_ODDS);
    }
    if (pricedCount / declared < minCompleteness) {
      detected.add(DATA_QUALITY_FLAG.LOW_MARKET_COMPLETENESS);
    }
    if (declared < minRunnerCount) {
      detected.add(DATA_QUALITY_FLAG.LOW_RUNNER_COUNT);
    }
  }

  // Stale odds need a known snapshot age.
  if (isFiniteNumber(input.snapshotAgeMs) && input.snapshotAgeMs > staleThresholdMs) {
    detected.add(DATA_QUALITY_FLAG.STALE_ODDS);
  }

  // Tipster signals.
  if (input.tipsterSelectionRunnerIds.length === 0) {
    detected.add(DATA_QUALITY_FLAG.NO_TIPSTER_SELECTIONS);
  } else {
    const priced = new Set(input.pricedRunnerIds.map(String));
    const anyMatched = input.tipsterSelectionRunnerIds.some((id) =>
      priced.has(String(id)),
    );
    if (!anyMatched) {
      detected.add(DATA_QUALITY_FLAG.TIPSTER_SELECTIONS_UNMATCHED);
    }
  }

  // Emit in canonical order (stable + de-duplicated).
  const flags = FLAG_ORDER.filter((flag) => detected.has(flag));

  // Computed metrics, alongside the flags. Each is null when its proving data
  // is absent (never fabricated): completeness needs a known declared count > 0;
  // declared count is echoed only when finite; odds age needs a known snapshot
  // age. `priced_runner_count` is always known.
  const metrics: DataQualityMetrics = {
    market_completeness:
      isFiniteNumber(declared) && declared > 0 ? pricedCount / declared : null,
    declared_runner_count: isFiniteNumber(declared) ? declared : null,
    priced_runner_count: pricedCount,
    odds_age_ms: isFiniteNumber(input.snapshotAgeMs)
      ? input.snapshotAgeMs
      : null,
  };

  return { flags, metrics };
}

/**
 * Overall run-quality verdict derived from a run's data-quality flags.
 * - `INVALID`  : the run cannot be trusted (no priced runners / no snapshot).
 * - `STALE`    : priced, but the odds are older than the freshness threshold.
 * - `DEGRADED` : priced and fresh, but part of the field is unpriced.
 * - `OK`       : none of the above.
 */
export type RunQuality = 'OK' | 'DEGRADED' | 'STALE' | 'INVALID';

/**
 * Reduces a run's data-quality flags to a single verdict, with strict priority
 * `INVALID > STALE > DEGRADED > OK` (the first matching tier wins).
 *
 * Pure and order-independent: it inspects flag membership only, so the input
 * order does not matter. Accepts the data-quality flag strings (the values of
 * {@link DATA_QUALITY_FLAG}); unrecognised flags are ignored.
 */
export function evaluateRunQuality(flags: readonly string[]): RunQuality {
  if (
    flags.includes(DATA_QUALITY_FLAG.NO_PRICED_RUNNERS) ||
    flags.includes(DATA_QUALITY_FLAG.NO_MARKET_SNAPSHOT)
  ) {
    return 'INVALID';
  }
  if (flags.includes(DATA_QUALITY_FLAG.STALE_ODDS)) {
    return 'STALE';
  }
  if (
    flags.includes(DATA_QUALITY_FLAG.LOW_MARKET_COMPLETENESS) ||
    flags.includes(DATA_QUALITY_FLAG.MISSING_RUNNER_ODDS)
  ) {
    return 'DEGRADED';
  }
  return 'OK';
}

/**
 * Non-invasive, advisory adjustments suggested by a run's data-quality flags.
 *
 * This is a VISIBILITY layer only: it records what the pipeline *could* do in
 * response to degraded inputs. It deliberately does NOT change probabilities,
 * staking, or selection \u2014 downstream logic does not consume it yet. Persisted
 * (via the model metadata) so the reasoning is auditable.
 */
export interface ModelAdjustments {
  /** Advisory: staking should be suppressed (market too incomplete to size a bet). */
  suppressStaking: boolean;
  /** Advisory: confidence should be reduced (odds stale or partially missing). */
  reduceConfidence: boolean;
  /** Human-readable explanation for each triggered rule (stable order). */
  notes: string[];
}

/**
 * Maps each adjustment-triggering flag to its advisory note. Iterated in this
 * fixed order so `notes` is deterministic and stable regardless of input order.
 */
const ADJUSTMENT_RULES: {
  flag: DataQualityFlag;
  field: 'suppressStaking' | 'reduceConfidence';
  note: string;
}[] = [
  {
    flag: DATA_QUALITY_FLAG.NO_PRICED_RUNNERS,
    field: 'suppressStaking',
    note: 'Suppressing staking: no priced runners in the field.',
  },
  {
    flag: DATA_QUALITY_FLAG.LOW_MARKET_COMPLETENESS,
    field: 'suppressStaking',
    note: 'Suppressing staking: market completeness is below the safe threshold.',
  },
  {
    flag: DATA_QUALITY_FLAG.STALE_ODDS,
    field: 'reduceConfidence',
    note: 'Reducing confidence: latest odds snapshot is stale.',
  },
  {
    flag: DATA_QUALITY_FLAG.MISSING_RUNNER_ODDS,
    field: 'reduceConfidence',
    note: 'Reducing confidence: at least one runner lacks usable odds.',
  },
];

/**
 * Derives the advisory {@link ModelAdjustments} from a run's data-quality flags.
 *
 * Rules (a flag may trigger at most one field):
 *   - `suppressStaking`  when `LOW_MARKET_COMPLETENESS` or `NO_PRICED_RUNNERS`.
 *   - `reduceConfidence` when `STALE_ODDS` or `MISSING_RUNNER_ODDS`.
 * `notes` carries one explanation per triggered rule, in a stable order.
 *
 * Pure and order-independent (membership checks only); unrecognised flags are
 * ignored. Additive and non-invasive \u2014 callers record it for visibility and do
 * not (yet) act on it.
 */
export function determineModelAdjustments(
  flags: readonly string[],
): ModelAdjustments {
  let suppressStaking = false;
  let reduceConfidence = false;
  const notes: string[] = [];

  for (const rule of ADJUSTMENT_RULES) {
    if (!flags.includes(rule.flag)) {
      continue;
    }
    if (rule.field === 'suppressStaking') {
      suppressStaking = true;
    } else {
      reduceConfidence = true;
    }
    notes.push(rule.note);
  }

  return { suppressStaking, reduceConfidence, notes };
}

/** Display glyph per severity, used by {@link formatDataQualitySummary}. */
const SEVERITY_ICON: Record<FlagSeverity, string> = {
  critical: '\u26D4', // ⛔
  warning: '\u26A0', // ⚠
  info: '\u2139', // ℹ
};

/** Base human-readable label for each known flag (detail appended separately). */
const FLAG_LABEL: Record<DataQualityFlag, string> = {
  [DATA_QUALITY_FLAG.NO_MARKET_SNAPSHOT]: 'No market snapshot',
  [DATA_QUALITY_FLAG.NO_PRICED_RUNNERS]: 'No priced runners',
  [DATA_QUALITY_FLAG.MISSING_RUNNER_ODDS]: 'Missing runner odds',
  [DATA_QUALITY_FLAG.LOW_MARKET_COMPLETENESS]: 'Low market completeness',
  [DATA_QUALITY_FLAG.STALE_ODDS]: 'Odds are stale',
  [DATA_QUALITY_FLAG.LOW_RUNNER_COUNT]: 'Low runner count',
  [DATA_QUALITY_FLAG.NO_TIPSTER_SELECTIONS]: 'No tipster selections',
  [DATA_QUALITY_FLAG.TIPSTER_SELECTIONS_UNMATCHED]: 'Tipster selections unmatched',
};

function isFiniteNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Builds the optional `(detail)` suffix for a flag from the metrics, when the
 * relevant metric is present. Returns '' when the metric is missing (safe
 * fallback) or the flag has no metric-derived detail.
 */
function flagDetail(
  flag: string,
  metrics: Partial<DataQualityMetrics> | null | undefined,
): string {
  if (!metrics) {
    return '';
  }
  if (
    flag === DATA_QUALITY_FLAG.LOW_MARKET_COMPLETENESS &&
    isFiniteNum(metrics.market_completeness)
  ) {
    return ` (${metrics.market_completeness.toFixed(2)})`;
  }
  if (flag === DATA_QUALITY_FLAG.STALE_ODDS && isFiniteNum(metrics.odds_age_ms)) {
    const minutes = metrics.odds_age_ms / 60_000;
    return ` (${minutes.toFixed(1)} min old)`;
  }
  if (
    flag === DATA_QUALITY_FLAG.MISSING_RUNNER_ODDS &&
    isFiniteNum(metrics.priced_runner_count) &&
    isFiniteNum(metrics.declared_runner_count)
  ) {
    return ` (${metrics.priced_runner_count}/${metrics.declared_runner_count} priced)`;
  }
  return '';
}

/**
 * Formats a run's data-quality flags into human-readable display lines, each
 * prefixed by a severity glyph (⛔ critical / ⚠ warning / ℹ info) and enriched
 * with a metric detail when one is available, e.g.:
 *
 *   ["⚠ Low market completeness (0.72)",
 *    "⚠ Odds are stale (4.2 min old)",
 *    "ℹ No tipster selections"]
 *
 * Pure and side-effect-free (no UI, no I/O): it maps each flag in the order
 * given. Unknown flags are still rendered (raw flag string, `info` glyph) rather
 * than dropped. `metrics` is optional/partial; a missing metric simply omits the
 * `(detail)` suffix (safe fallback) \u2014 nothing is fabricated. An empty/omitted
 * flags list yields an empty array.
 */
export function formatDataQualitySummary(
  flags: readonly string[] | null | undefined,
  metrics?: Partial<DataQualityMetrics> | null,
): string[] {
  if (!flags || flags.length === 0) {
    return [];
  }
  return flags.map((flag) => {
    const icon = SEVERITY_ICON[getFlagSeverity(flag)];
    const label = FLAG_LABEL[flag as DataQualityFlag] ?? flag;
    return `${icon} ${label}${flagDetail(flag, metrics)}`;
  });
}
