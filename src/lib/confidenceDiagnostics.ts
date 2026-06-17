/**
 * Pure helpers for the read-only "confidence decomposition" diagnostic
 * (scripts/confidenceAudit.ts). Phase 5 of the autonomous race-day workflow.
 *
 * This module EXPLAINS why a model run is Low / Medium / High confidence by
 * decomposing it into named components (data, market, tipster, contextual,
 * race-type, execution) derived from ALREADY-STORED observability. It is purely
 * DIAGNOSTIC / DISPLAY-ONLY: it never changes the model's probability, staking,
 * ranking, recommendation, or the persisted confidence; it never makes any
 * component model-active; and it never rescales a LOW confidence upward. The
 * overall figure is a "weakest-link" summary, so it can only ever match or fall
 * below the components — never inflate them.
 *
 * Everything here is pure and deterministic: the per-component derivation, the
 * summary counts, and the Markdown rendering. There is no database access, no
 * network, and no mutation. Nothing is fabricated: a component that cannot be
 * derived returns `unknown` with a reason, and missing values render as an em
 * dash. The original model confidence is read for display only — never written.
 */

import { getFlagSeverity } from './modelDataQuality';

/** The diagnostic component scale. */
export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'unknown';

/** One derived confidence component: a level plus a short factual reason. */
export interface ConfidenceComponent {
  level: ConfidenceLevel;
  reason: string;
}

/** Field size at/above which a field is treated as "large" (volatility risk). */
export const LARGE_FIELD_SIZE = 16;

/** Diagnostic market-completeness floor (display-only; mirrors the model's 0.8). */
export const DIAGNOSTIC_MIN_COMPLETENESS = 0.8;

/** Diagnostic model-vs-market separation that counts as "clear" (5 points). */
export const DIAGNOSTIC_CLEAR_SEPARATION = 0.05;

const LEVEL_SCORE: Record<Exclude<ConfidenceLevel, 'unknown'>, number> = {
  low: 1,
  medium: 2,
  high: 3,
};
const SCORE_LEVEL: Record<number, Exclude<ConfidenceLevel, 'unknown'>> = {
  1: 'low',
  2: 'medium',
  3: 'high',
};

const DASH = '\u2014';

/* -------------------------------------------------------------------------- */
/* Arguments + output path                                                    */
/* -------------------------------------------------------------------------- */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parsed CLI options for the confidence audit. */
export interface ConfidenceAuditArgs {
  date?: string;
  course?: string;
}

/** Parses argv (sliced past `node script`). `--date` strict YYYY-MM-DD. Pure. */
export function parseConfidenceAuditArgs(argv: readonly string[]): ConfidenceAuditArgs {
  const args: ConfidenceAuditArgs = {};
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

/** Builds `reports/confidence-audit-<date>[-<course-slug>].md`. Pure. */
export function buildConfidenceAuditPath(date: string, course?: string | null): string {
  const slug = (course ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `reports/confidence-audit-${date}-${slug}.md` : `reports/confidence-audit-${date}.md`;
}

/** The stored signals the diagnostic derives its components from. */
export interface ConfidenceInputs {
  /** Run-quality verdict (OK / DEGRADED / STALE / INVALID), or null. */
  run_quality: string | null;
  /** Data-quality flags recorded on the run. */
  data_quality_flags: string[];
  /** Tipster/model alignment label, or null. */
  tipster_alignment_label: string | null;
  /** Market completeness (priced/declared, 0..1), or null. */
  market_completeness: number | null;
  /** Field size (declared runners), or null. */
  field_size: number | null;
  /** Whether many runners share a near-identical EV (little separation), or null. */
  similar_ev: boolean | null;
  /** |model_prob − market_prob| for the pick, or null. */
  model_market_separation: number | null;
  /** The pick's pre-off odds, or null. */
  pick_odds: number | null;
  /** Whether those pre-off odds are stale (true/false), or null when unknown. */
  odds_stale: boolean | null;
  /** Whether the race is a handicap, or null when unknown. */
  is_handicap: boolean | null;
  /** Whether reviewed contextual/GenAI features exist (always false this phase). */
  has_reviewed_context: boolean;
}

/* -------------------------------------------------------------------------- */
/* EV-clustering helper (pure)                                                */
/* -------------------------------------------------------------------------- */

/**
 * True when the top runners' EVs are clustered within `epsilon` (so the model
 * barely separates them from the market). Needs at least two finite EVs. Pure.
 */
export function detectSimilarEv(evs: ReadonlyArray<number | null>, epsilon = 0.01): boolean {
  const finite = evs.filter((e): e is number => typeof e === 'number' && Number.isFinite(e));
  if (finite.length < 2) return false;
  const sorted = [...finite].sort((a, b) => b - a);
  const top = sorted.slice(0, Math.min(3, sorted.length));
  return Math.max(...top) - Math.min(...top) <= epsilon;
}

/* -------------------------------------------------------------------------- */
/* Component derivations (pure)                                               */
/* -------------------------------------------------------------------------- */

function criticalFlags(flags: readonly string[]): string[] {
  return flags.filter((f) => getFlagSeverity(f) === 'critical');
}
function warningFlags(flags: readonly string[]): string[] {
  return flags.filter((f) => getFlagSeverity(f) === 'warning');
}

/**
 * data_confidence: LOW when run quality is STALE/INVALID or a critical flag
 * exists; MEDIUM when DEGRADED (or OK with a material warning flag, e.g. missing
 * runner odds); HIGH when OK with no material flags; UNKNOWN when not recorded.
 * Pure.
 */
export function deriveDataConfidence(inputs: ConfidenceInputs): ConfidenceComponent {
  const q = (inputs.run_quality ?? '').trim();
  const flags = inputs.data_quality_flags ?? [];
  if (q === '') return { level: 'unknown', reason: 'run quality not recorded' };
  if (q === 'INVALID' || q === 'STALE') return { level: 'low', reason: `run quality ${q}` };
  const critical = criticalFlags(flags);
  if (critical.length > 0) return { level: 'low', reason: `critical data-quality flag(s): ${critical.join(', ')}` };
  if (q === 'DEGRADED') return { level: 'medium', reason: 'DEGRADED data quality' };
  if (q === 'OK') {
    if (flags.includes('MISSING_RUNNER_ODDS')) {
      return { level: 'medium', reason: 'OK overall but missing runner odds' };
    }
    const warnings = warningFlags(flags);
    if (warnings.length > 0) return { level: 'medium', reason: `OK overall but warning flag(s): ${warnings.join(', ')}` };
    return { level: 'high', reason: 'run quality OK, no material flags' };
  }
  return { level: 'unknown', reason: `unrecognised run quality "${q}"` };
}

/**
 * market_confidence: from price completeness, field size, model-vs-market
 * separation, and EV clustering. LOW when completeness is below the floor or
 * many runners share an EV; HIGH when prices are complete with clear separation;
 * MEDIUM otherwise; UNKNOWN when no market metric is present. Pure.
 */
export function deriveMarketConfidence(inputs: ConfidenceInputs): ConfidenceComponent {
  const { market_completeness, field_size, similar_ev, model_market_separation } = inputs;
  if (
    market_completeness == null &&
    field_size == null &&
    similar_ev == null &&
    model_market_separation == null
  ) {
    return { level: 'unknown', reason: 'no market metrics recorded' };
  }
  if (market_completeness != null && market_completeness < DIAGNOSTIC_MIN_COMPLETENESS) {
    return { level: 'low', reason: `low market completeness (${market_completeness.toFixed(2)})` };
  }
  if (similar_ev === true) {
    return { level: 'low', reason: 'many runners share a near-identical EV (little model-vs-market separation)' };
  }
  if (
    (market_completeness == null || market_completeness >= 0.95) &&
    model_market_separation != null &&
    model_market_separation >= DIAGNOSTIC_CLEAR_SEPARATION &&
    similar_ev === false
  ) {
    return { level: 'high', reason: 'complete prices with clear model-vs-market separation' };
  }
  return { level: 'medium', reason: 'prices available; limited or unknown model-vs-market separation' };
}

/**
 * tipster_confidence from the alignment label: ALIGNED -> high,
 * PARTIALLY_ALIGNED -> medium, DIVERGENT -> low, NO_TIPSTER_CONSENSUS /
 * NO_RECOMMENDATION -> unknown (explicitly, market-only). Pure.
 */
export function deriveTipsterConfidence(label: string | null): ConfidenceComponent {
  switch (label) {
    case 'ALIGNED':
      return { level: 'high', reason: 'tipster consensus ALIGNED with the model pick' };
    case 'PARTIALLY_ALIGNED':
      return { level: 'medium', reason: 'tipster consensus PARTIALLY_ALIGNED with the model' };
    case 'DIVERGENT':
      return { level: 'low', reason: 'tipsters DIVERGENT from the model pick' };
    case 'NO_TIPSTER_CONSENSUS':
      return { level: 'unknown', reason: 'no tipster consensus (market-only signal, not a negative)' };
    case 'NO_RECOMMENDATION':
      return { level: 'unknown', reason: 'no model recommendation to compare against' };
    default:
      return {
        level: 'unknown',
        reason: label ? `unrecognised alignment "${label}"` : 'tipster alignment not recorded',
      };
  }
}

/**
 * contextual_confidence is UNKNOWN until reviewed contextual/GenAI features
 * exist (the shadow layer is not model-active). Pure.
 */
export function deriveContextualConfidence(hasReviewedContext: boolean): ConfidenceComponent {
  if (!hasReviewedContext) {
    return { level: 'unknown', reason: 'no reviewed contextual/GenAI features (shadow layer is not model-active)' };
  }
  return { level: 'unknown', reason: 'contextual features present but not scored in this phase' };
}

/**
 * race_type_confidence: LOW for large-field handicaps, MEDIUM for smaller
 * handicaps or large non-handicaps, HIGH for small non-handicaps, UNKNOWN when
 * race-type info is missing. Pure.
 */
export function deriveRaceTypeConfidence(inputs: ConfidenceInputs): ConfidenceComponent {
  const { is_handicap, field_size } = inputs;
  if (is_handicap == null && field_size == null) {
    return { level: 'unknown', reason: 'no race-type or field-size information' };
  }
  const large = field_size != null && field_size >= LARGE_FIELD_SIZE;
  if (is_handicap === true && large) {
    return { level: 'low', reason: `large-field handicap (${field_size} runners)` };
  }
  if (is_handicap === true) {
    return { level: 'medium', reason: field_size != null ? `handicap (${field_size} runners)` : 'handicap' };
  }
  if (large) {
    return { level: 'medium', reason: `large field (${field_size} runners)` };
  }
  if (is_handicap === false) {
    return { level: 'high', reason: field_size != null ? `non-handicap, ${field_size} runners` : 'non-handicap' };
  }
  return { level: 'unknown', reason: 'race type unknown (handicap flag missing)' };
}

/**
 * execution_confidence from whether the pick's pre-off odds are present and
 * fresh. LOW when odds are missing or stale; HIGH when present and fresh; MEDIUM
 * when present with unknown staleness. Display-only — it does NOT imply a live
 * executable price. Pure.
 */
export function deriveExecutionConfidence(inputs: ConfidenceInputs): ConfidenceComponent {
  const { pick_odds, odds_stale } = inputs;
  if (pick_odds == null) return { level: 'low', reason: 'no pre-off odds recorded for the pick' };
  if (odds_stale === true) return { level: 'low', reason: 'pre-off odds are stale' };
  if (odds_stale === false) {
    return { level: 'high', reason: 'pre-off odds present and fresh (display only; not a live executable price)' };
  }
  return { level: 'medium', reason: 'pre-off odds present; staleness unknown (display only; not a live executable price)' };
}

/* -------------------------------------------------------------------------- */
/* Per-race diagnostic (pure)                                                 */
/* -------------------------------------------------------------------------- */

/** Per-race metadata + the stored inputs the diagnostic reads. */
export interface RaceConfidenceInput {
  race_id: string;
  off_time: string | null;
  race_name: string | null;
  model_pick_name: string | null;
  /** The model's ORIGINAL confidence label, shown for reference (never changed). */
  original_confidence_label: string | null;
  inputs: ConfidenceInputs;
}

/** The fully-derived per-race confidence diagnostic. */
export interface RaceConfidenceDiagnostic {
  race_id: string;
  off_time: string | null;
  race_name: string | null;
  model_pick_name: string | null;
  original_confidence_label: string | null;
  data: ConfidenceComponent;
  market: ConfidenceComponent;
  tipster: ConfidenceComponent;
  contextual: ConfidenceComponent;
  race_type: ConfidenceComponent;
  execution: ConfidenceComponent;
  overall: ConfidenceComponent;
  warnings: string[];
}

/** The six component names, in display order. */
export const COMPONENT_NAMES = [
  'data',
  'market',
  'tipster',
  'contextual',
  'race_type',
  'execution',
] as const;
export type ComponentName = (typeof COMPONENT_NAMES)[number];

/**
 * Combines the derived components into an OVERALL diagnostic level using a
 * weakest-link rule over the KNOWN components (unknowns are not counted). This
 * can never inflate confidence above its weakest component, and is display-only.
 * Pure.
 */
function deriveOverallDiagnostic(
  named: ReadonlyArray<readonly [ComponentName, ConfidenceComponent]>,
): ConfidenceComponent {
  const known = named.filter(([, c]) => c.level !== 'unknown');
  if (known.length === 0) {
    return { level: 'unknown', reason: 'no components could be derived from stored metadata' };
  }
  const minScore = Math.min(...known.map(([, c]) => LEVEL_SCORE[c.level as Exclude<ConfidenceLevel, 'unknown'>]));
  const level = SCORE_LEVEL[minScore];
  const limiting = known
    .filter(([, c]) => LEVEL_SCORE[c.level as Exclude<ConfidenceLevel, 'unknown'>] === minScore)
    .map(([name]) => name);
  return {
    level,
    reason:
      `weakest-link diagnostic, limited by ${limiting.join(', ')} ` +
      `(display-only; does not change the model's confidence, ranking, or stake)`,
  };
}

/** Builds the full per-race diagnostic from its inputs. Pure; deterministic. */
export function buildRaceDiagnostic(race: RaceConfidenceInput): RaceConfidenceDiagnostic {
  const data = deriveDataConfidence(race.inputs);
  const market = deriveMarketConfidence(race.inputs);
  const tipster = deriveTipsterConfidence(race.inputs.tipster_alignment_label);
  const contextual = deriveContextualConfidence(race.inputs.has_reviewed_context);
  const race_type = deriveRaceTypeConfidence(race.inputs);
  const execution = deriveExecutionConfidence(race.inputs);

  const named: ReadonlyArray<readonly [ComponentName, ConfidenceComponent]> = [
    ['data', data],
    ['market', market],
    ['tipster', tipster],
    ['contextual', contextual],
    ['race_type', race_type],
    ['execution', execution],
  ];
  const overall = deriveOverallDiagnostic(named);
  const warnings = named
    .filter(([, c]) => c.level === 'unknown')
    .map(([name, c]) => `${name}_confidence is unknown — ${c.reason}`);

  return {
    race_id: race.race_id,
    off_time: race.off_time,
    race_name: race.race_name,
    model_pick_name: race.model_pick_name,
    original_confidence_label: race.original_confidence_label,
    data,
    market,
    tipster,
    contextual,
    race_type,
    execution,
    overall,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Summary (pure)                                                             */
/* -------------------------------------------------------------------------- */

/** True when a label is "low" (case-insensitive). */
function isLowLabel(label: string | null): boolean {
  return typeof label === 'string' && label.trim().toLowerCase() === 'low';
}

/** A label + count pair. */
export interface LabelCount {
  label: string;
  count: number;
}

const EMPTY_LEVEL_COUNTS = (): Record<ConfidenceLevel, number> => ({ high: 0, medium: 0, low: 0, unknown: 0 });

/** The audit-wide confidence summary. */
export interface ConfidenceAuditSummary {
  /** Original model confidence labels (low/medium/high/unknown). */
  original_label_counts: Record<ConfidenceLevel, number>;
  /** Per-component level counts. */
  component_counts: Record<ComponentName, Record<ConfidenceLevel, number>>;
  /** Which components are LOW, and how often (repeated low-confidence causes). */
  repeated_low_causes: LabelCount[];
  /** Races where original confidence was LOW but data_confidence is high (OK). */
  low_label_but_data_ok: number;
  /** Races where original LOW and tipsters were DIVERGENT / NO_TIPSTER_CONSENSUS. */
  low_label_tipster_divergent: number;
  /** Races where original LOW and data quality was degraded (data not high). */
  low_label_data_degraded: number;
}

/** Normalises an original confidence label to a level bucket. */
function labelBucket(label: string | null): ConfidenceLevel {
  const l = (label ?? '').trim().toLowerCase();
  if (l === 'low') return 'low';
  if (l === 'medium') return 'medium';
  if (l === 'high') return 'high';
  return 'unknown';
}

/** Aggregates per-race diagnostics into the audit summary. Pure. */
export function summarizeConfidenceAudit(
  diagnostics: readonly RaceConfidenceDiagnostic[],
): ConfidenceAuditSummary {
  const original_label_counts = EMPTY_LEVEL_COUNTS();
  const component_counts: Record<ComponentName, Record<ConfidenceLevel, number>> = {
    data: EMPTY_LEVEL_COUNTS(),
    market: EMPTY_LEVEL_COUNTS(),
    tipster: EMPTY_LEVEL_COUNTS(),
    contextual: EMPTY_LEVEL_COUNTS(),
    race_type: EMPTY_LEVEL_COUNTS(),
    execution: EMPTY_LEVEL_COUNTS(),
  };
  const lowCauses = new Map<ComponentName, number>();
  let low_label_but_data_ok = 0;
  let low_label_tipster_divergent = 0;
  let low_label_data_degraded = 0;

  for (const d of diagnostics) {
    original_label_counts[labelBucket(d.original_confidence_label)] += 1;

    for (const name of COMPONENT_NAMES) {
      const level = d[name].level;
      component_counts[name][level] += 1;
      if (level === 'low') lowCauses.set(name, (lowCauses.get(name) ?? 0) + 1);
    }

    if (isLowLabel(d.original_confidence_label)) {
      if (d.data.level === 'high') low_label_but_data_ok += 1;
      if (d.data.level !== 'high' && d.data.level !== 'unknown') low_label_data_degraded += 1;
    }
  }

  // Tipster-driven low labels: derive from the tipster component reason
  // (DIVERGENT / NO_TIPSTER_CONSENSUS) for races whose original label is low.
  for (const d of diagnostics) {
    if (!isLowLabel(d.original_confidence_label)) continue;
    const reason = d.tipster.reason.toLowerCase();
    if (reason.includes('divergent') || reason.includes('no tipster consensus')) {
      low_label_tipster_divergent += 1;
    }
  }

  const repeated_low_causes = [...lowCauses.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return {
    original_label_counts,
    component_counts,
    repeated_low_causes,
    low_label_but_data_ok,
    low_label_tipster_divergent,
    low_label_data_degraded,
  };
}

/* -------------------------------------------------------------------------- */
/* Markdown rendering (pure, deterministic)                                   */
/* -------------------------------------------------------------------------- */

function orDash(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return DASH;
  return String(value);
}

function fmtOffTimeHm(offTime: string | null): string {
  if (!offTime) return DASH;
  const ms = new Date(offTime).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 16) : DASH;
}

/** Renders one component as `level — reason`. */
function renderComponent(c: ConfidenceComponent): string {
  return `${c.level} ${DASH} ${c.reason}`;
}

/** The full audit payload passed to {@link renderConfidenceAuditMarkdown}. */
export interface ConfidenceAuditReport {
  date: string;
  course: string | null;
  generatedAt: string;
  races: RaceConfidenceInput[];
}

function renderRaceSection(d: RaceConfidenceDiagnostic): string {
  const lines: string[] = [];
  lines.push(`## ${fmtOffTimeHm(d.off_time)} ${DASH} ${d.race_name ?? '(unknown race)'}`);
  lines.push('');
  lines.push(`- Model pick: ${orDash(d.model_pick_name)}`);
  lines.push(`- Original confidence (unchanged): ${orDash(d.original_confidence_label)}`);
  lines.push('');
  lines.push(`- data_confidence: ${renderComponent(d.data)}`);
  lines.push(`- market_confidence: ${renderComponent(d.market)}`);
  lines.push(`- tipster_confidence: ${renderComponent(d.tipster)}`);
  lines.push(`- contextual_confidence: ${renderComponent(d.contextual)}`);
  lines.push(`- race_type_confidence: ${renderComponent(d.race_type)}`);
  lines.push(`- execution_confidence: ${renderComponent(d.execution)}`);
  lines.push(`- overall diagnostic: ${renderComponent(d.overall)}`);
  if (d.warnings.length > 0) {
    lines.push('');
    lines.push('### Warnings');
    for (const w of d.warnings) lines.push(`- ⚠️ ${w}`);
  }
  return lines.join('\n');
}

function renderLevelCounts(counts: Record<ConfidenceLevel, number>): string {
  return `low ${counts.low} · medium ${counts.medium} · high ${counts.high} · unknown ${counts.unknown}`;
}

/**
 * Renders the full confidence audit as deterministic Markdown. Pure: the same
 * report object always yields the same string. Display-only and explanatory: it
 * states clearly that nothing here changes the model's confidence, ranking, or
 * stake. Missing values render as an em dash; underivable components as
 * `unknown` with a reason.
 */
export function renderConfidenceAuditMarkdown(report: ConfidenceAuditReport): string {
  const diagnostics = report.races.map(buildRaceDiagnostic);
  const summary = summarizeConfidenceAudit(diagnostics);

  const blocks: string[] = [];

  blocks.push(`# Confidence decomposition audit ${DASH} ${report.date}`);
  blocks.push(
    [`Course: ${report.course ?? 'All'}`, `Generated: ${report.generatedAt}`, `Races: ${report.races.length}`].join('  \n'),
  );
  blocks.push(
    [
      '> Diagnostic / display-only. This decomposes WHY each run is Low/Medium/High',
      '> confidence from stored metadata. It does NOT change the model probability,',
      '> staking, ranking, recommendation, or the persisted confidence, and it never',
      '> rescales a LOW confidence upward. Unknown components are shown honestly.',
      '> Decision-support only — not betting advice.',
    ].join('\n'),
  );

  // Summary.
  const summaryLines = [
    '## Summary',
    '',
    `- Original confidence labels: ${renderLevelCounts(summary.original_label_counts)}`,
    '',
    'Component breakdown:',
    `- data_confidence: ${renderLevelCounts(summary.component_counts.data)}`,
    `- market_confidence: ${renderLevelCounts(summary.component_counts.market)}`,
    `- tipster_confidence: ${renderLevelCounts(summary.component_counts.tipster)}`,
    `- contextual_confidence: ${renderLevelCounts(summary.component_counts.contextual)}`,
    `- race_type_confidence: ${renderLevelCounts(summary.component_counts.race_type)}`,
    `- execution_confidence: ${renderLevelCounts(summary.component_counts.execution)}`,
    '',
    `- Repeated low-confidence causes: ${
      summary.repeated_low_causes.length
        ? summary.repeated_low_causes.map((c) => `${c.label} (${c.count})`).join(', ')
        : DASH
    }`,
    `- Races where original was LOW but data quality was OK: ${summary.low_label_but_data_ok}`,
    `- Races where original was LOW with DIVERGENT / no-consensus tipsters: ${summary.low_label_tipster_divergent}`,
    `- Races where original was LOW and data quality was degraded: ${summary.low_label_data_degraded}`,
  ];
  blocks.push(summaryLines.join('\n'));

  // Per-race sections.
  if (diagnostics.length === 0) {
    blocks.push('_No races matched the given date/course._');
  } else {
    for (const d of diagnostics) blocks.push(renderRaceSection(d));
  }

  return blocks.join('\n\n') + '\n';
}
