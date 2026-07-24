/**
 * Nationwide write-boundary evidence — pure evaluation, comparison and
 * rendering (Phase 7A.2b evidence pack).
 *
 * Backs the SELECT-ONLY `audit:nationwide-write-boundary` snapshot command and
 * the read-only `audit:nationwide-write-boundary:compare` helper. Its purpose
 * is to PROVE, before and after a future attended nationwide live-provider
 * dry-run, that every FORBIDDEN persistence category had a ZERO delta while
 * the ALLOWED provider-ingestion categories were free to grow.
 *
 * This module performs NO I/O of any kind: no database, no network, no
 * filesystem, no child processes. The CLI gathers raw counts through an
 * injected SELECT-only client and hands them here.
 *
 * SCHEMA GROUNDING — every relationship below was verified against the actual
 * repository migrations and a read-only probe of the live database; none is
 * assumed from documentation:
 *   - `races.meeting_date` is the ONLY direct race-date column; everything else
 *     is scoped through `race_id` (one hop) or through a further parent (two
 *     hops).
 *   - `model_runner_scores` is keyed by `model_run_id` (NOT `race_id`), so it is
 *     scoped model_runner_scores -> model_runs -> races.
 *   - `runner_quotes` carries `snapshot_id` (NOT `race_id`), so it is scoped
 *     runner_quotes -> market_snapshots -> races.
 *   - `recommendations` carries BOTH `model_run_id` and `race_id`; the direct
 *     `race_id` hop is used.
 *   - `cron_runs` has NO race relationship at all (only `started_at` /
 *     `finished_at`), so it CANNOT be scoped to a race meeting date. It is
 *     reported honestly against the UTC calendar day of the requested date and
 *     flagged as a different scoping semantic — never presented as race-scoped.
 *   - `ml_training_examples` and `genai_commentary` both exist in this schema
 *     and both carry `race_id`. `genai_commentary.race_id` is NULLABLE, so
 *     rows with a null race_id cannot be date-scoped (surfaced as a warning).
 *
 * Decision-support only — nothing here places a bet or mutates anything.
 */

/** Bumped only when the evidence shape changes in a way that affects comparison. */
export const WRITE_BOUNDARY_SCHEMA_VERSION = 1;

/** The nationwide scope this evidence pack describes. */
export const WRITE_BOUNDARY_SCOPE = 'all-uk-ire';

export type SnapshotLabel = 'before' | 'after';
export const SNAPSHOT_LABELS: readonly SnapshotLabel[] = ['before', 'after'];

/**
 * Why a category does or does not carry a number. These states are NEVER
 * collapsed into a zero — a missing table, a failed query and a genuine zero
 * are different facts.
 */
export type CategoryStatus =
  | 'counted' // available and counted for the date
  | 'table_missing' // the table does not exist in this schema
  | 'permission_denied' // the role may not read it
  | 'query_failed' // the query errored for another reason
  | 'not_scopable' // the table exists but cannot be scoped to a race date
  | 'not_applicable'; // this schema does not persist the feature at all

/** A category is either forbidden (must not grow) or allowed (may grow). */
export type CategoryKind = 'forbidden' | 'allowed';

export interface CategoryDefinition {
  id: string;
  label: string;
  kind: CategoryKind;
  /** The real table this counts. */
  table: string;
  /** The real date-scoping relationship used, in words. */
  relationship: string;
  /**
   * Mandatory forbidden categories must be conclusively counted for a
   * comparison to PASS. Optional ones (training / GenAI) may legitimately be
   * absent in another deployment and then force REVIEW, never a silent pass.
   */
  mandatory: boolean;
}

/** The single registry of what is measured, with its real table + relationship. */
export const WRITE_BOUNDARY_CATEGORIES: readonly CategoryDefinition[] = [
  // ---- ALLOWED operational ingestion (racecards + odds may create these) ----
  {
    id: 'stored_races',
    label: 'stored races',
    kind: 'allowed',
    table: 'races',
    relationship: 'races.meeting_date = <date> (direct)',
    mandatory: false,
  },
  {
    id: 'stored_runners',
    label: 'stored runners',
    kind: 'allowed',
    table: 'runners',
    relationship: 'runners.race_id -> races.meeting_date = <date>',
    mandatory: false,
  },
  {
    id: 'market_snapshots',
    label: 'market snapshots',
    kind: 'allowed',
    table: 'market_snapshots',
    relationship: 'market_snapshots.race_id -> races.meeting_date = <date>',
    mandatory: false,
  },
  {
    id: 'runner_quotes',
    label: 'runner quotes',
    kind: 'allowed',
    table: 'runner_quotes',
    relationship: 'runner_quotes.snapshot_id -> market_snapshots.race_id -> races.meeting_date = <date>',
    mandatory: false,
  },
  {
    id: 'cron_telemetry',
    label: 'cron/provider telemetry',
    kind: 'allowed',
    table: 'cron_runs',
    relationship:
      'cron_runs.finished_at within the UTC calendar day of <date> — NOT a race relationship (cron_runs has no race_id/meeting_date)',
    mandatory: false,
  },
  // ---- FORBIDDEN persistence (a read-only dry-run must not create these) ----
  {
    id: 'model_runs',
    label: 'persisted model runs',
    kind: 'forbidden',
    table: 'model_runs',
    relationship: 'model_runs.race_id -> races.meeting_date = <date>',
    mandatory: true,
  },
  {
    id: 'model_runner_scores',
    label: 'persisted model runner scores',
    kind: 'forbidden',
    table: 'model_runner_scores',
    relationship: 'model_runner_scores.model_run_id -> model_runs.race_id -> races.meeting_date = <date>',
    mandatory: true,
  },
  {
    id: 'recommendations',
    label: 'persisted recommendations',
    kind: 'forbidden',
    table: 'recommendations',
    relationship: 'recommendations.race_id -> races.meeting_date = <date> (direct hop; the table also carries model_run_id)',
    mandatory: true,
  },
  {
    id: 'locked_race_decisions',
    label: 'locked decision rows',
    kind: 'forbidden',
    table: 'locked_race_decisions',
    relationship:
      'locked_race_decisions.race_id -> races.meeting_date = <date> (ALL horizons, not just minutes_before = 5 — a research capture is still forbidden persistence)',
    mandatory: true,
  },
  {
    id: 'settled_races',
    label: 'settled races',
    kind: 'forbidden',
    table: 'races',
    relationship: "races.meeting_date = <date> AND lower(races.status) = 'result'",
    mandatory: true,
  },
  {
    id: 'runner_finish_positions',
    label: 'runners with a finish position',
    kind: 'forbidden',
    table: 'runners',
    relationship: 'runners.race_id -> races.meeting_date = <date> AND runners.finish_pos IS NOT NULL',
    mandatory: true,
  },
  {
    id: 'training_examples',
    label: 'persisted training capture rows',
    kind: 'forbidden',
    table: 'ml_training_examples',
    relationship: 'ml_training_examples.race_id -> races.meeting_date = <date>',
    mandatory: false,
  },
  {
    id: 'genai_artifacts',
    label: 'persisted GenAI commentary rows',
    kind: 'forbidden',
    table: 'genai_commentary',
    relationship: 'genai_commentary.race_id -> races.meeting_date = <date> (race_id is nullable; unlinked rows are unscopable)',
    mandatory: false,
  },
];

/** Convenience lookups. */
export const FORBIDDEN_CATEGORY_IDS = WRITE_BOUNDARY_CATEGORIES.filter((c) => c.kind === 'forbidden').map((c) => c.id);
export const ALLOWED_CATEGORY_IDS = WRITE_BOUNDARY_CATEGORIES.filter((c) => c.kind === 'allowed').map((c) => c.id);
export const MANDATORY_FORBIDDEN_CATEGORY_IDS = WRITE_BOUNDARY_CATEGORIES.filter(
  (c) => c.kind === 'forbidden' && c.mandatory,
).map((c) => c.id);

export function findCategory(id: string): CategoryDefinition | undefined {
  return WRITE_BOUNDARY_CATEGORIES.find((c) => c.id === id);
}

/* -------------------------------------------------------------------------- */
/* Raw gathering result -> evidence                                           */
/* -------------------------------------------------------------------------- */

/** What the CLI's SELECT-only gatherer produces for one category. */
export interface RawCategoryResult {
  status: CategoryStatus;
  /** Non-null ONLY when status is 'counted'. */
  count: number | null;
  /** Short, already-sanitised explanation (never a raw driver error object). */
  detail?: string;
}

export interface ClaimEvidence {
  /** Read-only status only — this pack never claims, heartbeats or releases. */
  status: 'absent' | 'live' | 'expired' | 'unknown' | 'unavailable';
  scope: string | null;
  generation: number | null;
  /** A short prefix only — the full owner id is NEVER rendered or stored here. */
  owner_prefix: string | null;
  detail?: string;
}

export interface GatheredSnapshot {
  date: string;
  label: SnapshotLabel;
  /** Distinct stored courses for the date (allowed/ingestion context). */
  courses: RawCategoryResult;
  categories: Record<string, RawCategoryResult>;
  claim: ClaimEvidence;
  warnings: string[];
}

export interface EvidenceCategory extends RawCategoryResult {
  id: string;
  label: string;
  kind: CategoryKind;
  table: string;
  relationship: string;
  mandatory: boolean;
}

export type SnapshotVerdict = 'OK' | 'REVIEW' | 'FAIL';

export interface WriteBoundaryEvidence {
  schema_version: number;
  date: string;
  label: SnapshotLabel;
  generated_at: string;
  read_only: true;
  database_mutated: false;
  scope: string;
  external_provider_calls: 'none';
  claim_operation: 'status_only';
  claim: ClaimEvidence;
  stored_courses: RawCategoryResult;
  categories: EvidenceCategory[];
  warnings: string[];
  invariant_violations: string[];
  unavailable_categories: string[];
  verdict: SnapshotVerdict;
  statement: string;
}

/** The fixed statement every snapshot carries. */
export const EVIDENCE_STATEMENT =
  'This evidence command performed SELECT-only reads plus a read-only producer claim status check. ' +
  'It changed nothing: no database row was inserted, updated or deleted, no provider route was called, ' +
  'no model was run, no recommendation/lock/result was created, and no producer claim was acquired, ' +
  'renewed, released or stolen.';

/** True when a category carries a usable number. Pure. */
export function isCounted(result: RawCategoryResult): boolean {
  return result.status === 'counted' && typeof result.count === 'number';
}

/**
 * Checks the invariants that can be evaluated from one snapshot. Violations are
 * SURFACED verbatim and never clamped. Pure.
 */
export function checkWriteBoundaryInvariants(
  categories: EvidenceCategory[],
  courses: RawCategoryResult,
): string[] {
  const violations: string[] = [];
  const byId = new Map(categories.map((c) => [c.id, c]));
  const num = (id: string): number | null => {
    const c = byId.get(id);
    return c && isCounted(c) ? (c.count as number) : null;
  };

  for (const c of [...categories, { ...courses, id: 'stored_courses' } as EvidenceCategory]) {
    if (c.status === 'counted') {
      const v = c.count;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        violations.push(`${c.id}: counted status but the value is not a non-negative integer (${String(v)})`);
      }
    } else if (c.count !== null && c.count !== undefined) {
      violations.push(`${c.id}: status "${c.status}" must not carry a count (${String(c.count)})`);
    }
  }

  const races = num('stored_races');
  const runners = num('stored_runners');
  const settled = num('settled_races');
  const finishes = num('runner_finish_positions');
  const locks = num('locked_race_decisions');
  const modelRuns = num('model_runs');
  const scores = num('model_runner_scores');

  if (races !== null && settled !== null && settled > races) {
    violations.push(`settled_races (${settled}) exceeds stored_races (${races}) for the date`);
  }
  if (runners !== null && finishes !== null && finishes > runners) {
    violations.push(`runner_finish_positions (${finishes}) exceeds stored_runners (${runners}) for the date`);
  }
  if (races !== null && locks !== null && locks > races) {
    violations.push(`locked_race_decisions (${locks}) exceeds stored_races (${races}) for the date`);
  }
  // model_runner_scores are keyed by model_run_id, so they cannot exist for the
  // date without at least one date-scoped model run.
  if (modelRuns !== null && scores !== null && modelRuns === 0 && scores > 0) {
    violations.push(`model_runner_scores (${scores}) exist for the date with zero date-scoped model_runs`);
  }
  const recommendations = num('recommendations');
  if (modelRuns !== null && recommendations !== null && modelRuns === 0 && recommendations > 0) {
    violations.push(`recommendations (${recommendations}) exist for the date with zero date-scoped model_runs`);
  }
  const courseCount = isCounted(courses) ? (courses.count as number) : null;
  if (races !== null && courseCount !== null && courseCount > races) {
    violations.push(`stored_courses (${courseCount}) exceeds stored_races (${races}) for the date`);
  }
  if (races !== null && races === 0 && courseCount !== null && courseCount > 0) {
    violations.push(`stored_courses (${courseCount}) is non-zero with zero stored_races`);
  }

  return violations;
}

/**
 * Assembles a deterministic evidence object from gathered raw results.
 * `generatedAtIso` is injected so output is reproducible in tests. Pure.
 */
export function buildWriteBoundaryEvidence(
  gathered: GatheredSnapshot,
  generatedAtIso: string,
): WriteBoundaryEvidence {
  const categories: EvidenceCategory[] = WRITE_BOUNDARY_CATEGORIES.map((def) => {
    const raw = gathered.categories[def.id] ?? {
      status: 'query_failed' as CategoryStatus,
      count: null,
      detail: 'no result was gathered for this category',
    };
    return {
      id: def.id,
      label: def.label,
      kind: def.kind,
      table: def.table,
      relationship: def.relationship,
      mandatory: def.mandatory,
      status: raw.status,
      count: raw.count,
      ...(raw.detail ? { detail: raw.detail } : {}),
    };
  });

  const invariantViolations = checkWriteBoundaryInvariants(categories, gathered.courses);
  const unavailable = categories.filter((c) => c.status !== 'counted').map((c) => c.id);

  // A mandatory forbidden category that could not be counted prevents the
  // snapshot from being usable evidence -> FAIL. Anything else unavailable is
  // REVIEW. Invariant violations are always FAIL.
  const mandatoryUnavailable = categories.filter((c) => c.mandatory && c.status !== 'counted');
  let verdict: SnapshotVerdict = 'OK';
  if (invariantViolations.length > 0 || mandatoryUnavailable.length > 0) verdict = 'FAIL';
  else if (unavailable.length > 0 || gathered.courses.status !== 'counted' || gathered.claim.status === 'unavailable')
    verdict = 'REVIEW';

  return {
    schema_version: WRITE_BOUNDARY_SCHEMA_VERSION,
    date: gathered.date,
    label: gathered.label,
    generated_at: generatedAtIso,
    read_only: true,
    database_mutated: false,
    scope: WRITE_BOUNDARY_SCOPE,
    external_provider_calls: 'none',
    claim_operation: 'status_only',
    claim: gathered.claim,
    stored_courses: gathered.courses,
    categories,
    warnings: [...gathered.warnings],
    invariant_violations: invariantViolations,
    unavailable_categories: unavailable,
    verdict,
    statement: EVIDENCE_STATEMENT,
  };
}

/* -------------------------------------------------------------------------- */
/* Comparison                                                                 */
/* -------------------------------------------------------------------------- */

export type ComparisonVerdict = 'PASS' | 'REVIEW' | 'FAIL';

export interface CategoryComparison {
  id: string;
  label: string;
  kind: CategoryKind;
  table: string;
  relationship: string;
  mandatory: boolean;
  before_status: CategoryStatus;
  after_status: CategoryStatus;
  before_count: number | null;
  after_count: number | null;
  /** Only when BOTH sides are counted. */
  delta: number | null;
  verdict: ComparisonVerdict;
  explanation: string;
}

export interface WriteBoundaryComparison {
  schema_version: number;
  date: string;
  generated_at: string;
  read_only: true;
  database_mutated: false;
  scope: string;
  verdict: ComparisonVerdict;
  categories: CategoryComparison[];
  structural_failures: string[];
  warnings: string[];
  statement: string;
}

export const COMPARISON_STATEMENT =
  'This comparison read two local evidence files only. It performed no database query, no provider call, ' +
  'no model execution and no claim operation.';

/**
 * Compares a before/after evidence pair. Pure and deterministic.
 *
 * Forbidden categories must have a ZERO delta with BOTH sides counted to PASS.
 * A DECREASE is never silently passed: a read-only dry-run must not delete
 * forbidden rows either, so it is surfaced as FAIL. Allowed ingestion
 * categories may grow freely and never fail the run.
 */
export function compareWriteBoundaryEvidence(
  before: WriteBoundaryEvidence,
  after: WriteBoundaryEvidence,
  generatedAtIso: string,
): WriteBoundaryComparison {
  const structural: string[] = [];
  const warnings: string[] = [];

  if (before.date !== after.date) {
    structural.push(`date mismatch: before is ${before.date}, after is ${after.date}`);
  }
  if (before.label !== 'before') structural.push(`the "before" snapshot is labelled "${before.label}"`);
  if (after.label !== 'after') structural.push(`the "after" snapshot is labelled "${after.label}"`);
  if (before.schema_version !== after.schema_version) {
    structural.push(
      `incompatible schema versions: before ${before.schema_version}, after ${after.schema_version} — the comparison cannot be trusted`,
    );
  }
  if (before.invariant_violations.length > 0) {
    structural.push(`the before snapshot has ${before.invariant_violations.length} invariant violation(s)`);
  }
  if (after.invariant_violations.length > 0) {
    structural.push(`the after snapshot has ${after.invariant_violations.length} invariant violation(s)`);
  }

  const beforeById = new Map(before.categories.map((c) => [c.id, c]));
  const afterById = new Map(after.categories.map((c) => [c.id, c]));

  const categories: CategoryComparison[] = WRITE_BOUNDARY_CATEGORIES.map((def) => {
    const b = beforeById.get(def.id);
    const a = afterById.get(def.id);
    const bStatus: CategoryStatus = b ? b.status : 'query_failed';
    const aStatus: CategoryStatus = a ? a.status : 'query_failed';
    const bCount = b && isCounted(b) ? (b.count as number) : null;
    const aCount = a && isCounted(a) ? (a.count as number) : null;
    const bothCounted = bCount !== null && aCount !== null;
    const delta = bothCounted ? (aCount as number) - (bCount as number) : null;

    let verdict: ComparisonVerdict;
    let explanation: string;

    if (def.kind === 'allowed') {
      if (!bothCounted) {
        verdict = 'REVIEW';
        explanation = `allowed ingestion category could not be compared (before: ${bStatus}, after: ${aStatus}); increases here are expected and never a failure`;
      } else if ((delta as number) < 0) {
        verdict = 'REVIEW';
        explanation = `allowed ingestion count DECREASED by ${Math.abs(delta as number)} — unexpected for ingestion; review why rows disappeared`;
      } else {
        verdict = 'PASS';
        explanation = `allowed ingestion delta +${delta} (expected: provider ingestion may add rows)`;
      }
    } else if (!bothCounted) {
      verdict = 'REVIEW';
      explanation =
        `forbidden category could not be conclusively compared (before: ${bStatus}, after: ${aStatus}). ` +
        `A missing/failed category is NEVER treated as zero, so a zero delta cannot be proven here.`;
    } else if ((delta as number) > 0) {
      verdict = 'FAIL';
      explanation = `FORBIDDEN persistence INCREASED by ${delta} (${bCount} -> ${aCount}) — the run wrote rows it must never write`;
    } else if ((delta as number) < 0) {
      verdict = 'FAIL';
      explanation =
        `FORBIDDEN persistence DECREASED by ${Math.abs(delta as number)} (${bCount} -> ${aCount}) — a read-only dry-run ` +
        `must not delete these rows either; this is surfaced, never silently passed`;
    } else {
      verdict = 'PASS';
      explanation = `zero delta (${bCount} -> ${aCount}) — no forbidden persistence occurred`;
    }

    return {
      id: def.id,
      label: def.label,
      kind: def.kind,
      table: def.table,
      relationship: def.relationship,
      mandatory: def.mandatory,
      before_status: bStatus,
      after_status: aStatus,
      before_count: bCount,
      after_count: aCount,
      delta,
      verdict,
      explanation,
    };
  });

  for (const w of [...before.warnings, ...after.warnings]) {
    if (!warnings.includes(w)) warnings.push(w);
  }

  let verdict: ComparisonVerdict;
  if (structural.length > 0 || categories.some((c) => c.verdict === 'FAIL')) {
    verdict = 'FAIL';
  } else if (categories.some((c) => c.verdict === 'REVIEW')) {
    verdict = 'REVIEW';
  } else {
    verdict = 'PASS';
  }

  return {
    schema_version: WRITE_BOUNDARY_SCHEMA_VERSION,
    date: before.date === after.date ? before.date : `${before.date}/${after.date}`,
    generated_at: generatedAtIso,
    read_only: true,
    database_mutated: false,
    scope: WRITE_BOUNDARY_SCOPE,
    verdict,
    categories,
    structural_failures: structural,
    warnings,
    statement: COMPARISON_STATEMENT,
  };
}

/* -------------------------------------------------------------------------- */
/* Rendering (deterministic; no secrets)                                      */
/* -------------------------------------------------------------------------- */

function renderCount(result: { status: CategoryStatus; count: number | null; detail?: string }): string {
  if (result.status === 'counted') return String(result.count);
  return `${result.status.toUpperCase()}${result.detail ? ` (${result.detail})` : ''}`;
}

export function renderWriteBoundaryConsole(evidence: WriteBoundaryEvidence): string[] {
  const lines: string[] = [];
  lines.push(`Nationwide write-boundary evidence — ${evidence.date} — snapshot: ${evidence.label}`);
  lines.push('READ ONLY — SELECT-only reads + read-only claim status. No database mutation.');
  lines.push(`Scope: ${evidence.scope} · provider calls: ${evidence.external_provider_calls} · claim operation: ${evidence.claim_operation}`);
  lines.push('');
  lines.push(`Verdict: ${evidence.verdict}`);
  lines.push('');
  lines.push('Allowed operational ingestion (increases are EXPECTED):');
  lines.push(`  ${'stored courses'.padEnd(32)} ${renderCount(evidence.stored_courses)}`);
  for (const c of evidence.categories.filter((c) => c.kind === 'allowed')) {
    lines.push(`  ${c.label.padEnd(32)} ${renderCount(c)}`);
  }
  lines.push('');
  lines.push('Forbidden persistence (must NOT increase across a dry-run):');
  for (const c of evidence.categories.filter((c) => c.kind === 'forbidden')) {
    const flag = c.mandatory ? '' : ' [optional]';
    lines.push(`  ${c.label.padEnd(32)} ${renderCount(c)}${flag}`);
  }
  lines.push('');
  lines.push(
    `Producer claim (read-only status): ${evidence.claim.status}` +
      (evidence.claim.scope ? ` scope=${evidence.claim.scope}` : '') +
      (evidence.claim.generation !== null ? ` generation=${evidence.claim.generation}` : '') +
      (evidence.claim.owner_prefix ? ` owner=${evidence.claim.owner_prefix}…` : ''),
  );
  if (evidence.unavailable_categories.length > 0) {
    lines.push('');
    lines.push(`Unavailable/unscopable categories (never counted as zero): ${evidence.unavailable_categories.join(', ')}`);
  }
  if (evidence.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of evidence.warnings) lines.push(`  - ${w}`);
  }
  if (evidence.invariant_violations.length > 0) {
    lines.push('');
    lines.push('INVARIANT VIOLATIONS:');
    for (const v of evidence.invariant_violations) lines.push(`  - ${v}`);
  }
  lines.push('');
  lines.push(evidence.statement);
  return lines;
}

export function renderWriteBoundaryMarkdown(evidence: WriteBoundaryEvidence): string {
  const lines: string[] = [];
  lines.push(`# Nationwide write-boundary evidence — ${evidence.date} — ${evidence.label}`);
  lines.push('');
  lines.push(`Generated: ${evidence.generated_at}`);
  lines.push('');
  lines.push('**READ ONLY.** SELECT-only reads plus a read-only producer claim status check.');
  lines.push('No provider route was called, no model was run, no recommendation, lock or');
  lines.push('result was created, no producer claim was acquired/renewed/released/stolen,');
  lines.push('and no database row was mutated.');
  lines.push('');
  lines.push(`- Scope: \`${evidence.scope}\``);
  lines.push(`- Snapshot label: \`${evidence.label}\``);
  lines.push(`- Schema version: \`${evidence.schema_version}\``);
  lines.push(`- Verdict: **${evidence.verdict}**`);
  lines.push('');
  lines.push('## Allowed operational ingestion');
  lines.push('');
  lines.push('These are written by racecard/odds ingestion. Increases across a dry-run are expected and are never failures.');
  lines.push('');
  lines.push('| Category | Table | Date scoping | Value |');
  lines.push('| --- | --- | --- | --- |');
  lines.push(
    `| stored courses | \`races\` | \`distinct course where races.meeting_date = <date>\` | ${renderCount(evidence.stored_courses)} |`,
  );
  for (const c of evidence.categories.filter((c) => c.kind === 'allowed')) {
    lines.push(`| ${c.label} | \`${c.table}\` | \`${c.relationship}\` | ${renderCount(c)} |`);
  }
  lines.push('');
  lines.push('## Forbidden persistence');
  lines.push('');
  lines.push('A nationwide live-provider dry-run must produce a ZERO delta for every category below.');
  lines.push('');
  lines.push('| Category | Table | Date scoping | Mandatory | Value |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const c of evidence.categories.filter((c) => c.kind === 'forbidden')) {
    lines.push(
      `| ${c.label} | \`${c.table}\` | \`${c.relationship}\` | ${c.mandatory ? 'yes' : 'optional'} | ${renderCount(c)} |`,
    );
  }
  lines.push('');
  lines.push('## Optional / unavailable categories');
  lines.push('');
  if (evidence.unavailable_categories.length === 0) {
    lines.push('All categories were counted for this date.');
  } else {
    for (const id of evidence.unavailable_categories) {
      const c = evidence.categories.find((x) => x.id === id);
      lines.push(`- \`${id}\` — status \`${c?.status}\`${c?.detail ? `: ${c.detail}` : ''} (NOT counted as zero)`);
    }
  }
  lines.push('');
  lines.push('## Producer claim (read-only status)');
  lines.push('');
  lines.push(`- status: \`${evidence.claim.status}\``);
  lines.push(`- scope: \`${evidence.claim.scope ?? 'n/a'}\``);
  lines.push(`- generation: \`${evidence.claim.generation ?? 'n/a'}\``);
  lines.push(`- owner prefix: \`${evidence.claim.owner_prefix ?? 'n/a'}\` (the full owner id is never recorded)`);
  lines.push('');
  lines.push('## Warnings');
  lines.push('');
  if (evidence.warnings.length === 0) lines.push('None.');
  else for (const w of evidence.warnings) lines.push(`- ${w}`);
  lines.push('');
  lines.push('## Invariant violations');
  lines.push('');
  if (evidence.invariant_violations.length === 0) lines.push('None.');
  else for (const v of evidence.invariant_violations) lines.push(`- ${v}`);
  lines.push('');
  lines.push('## Limitations');
  lines.push('');
  lines.push('- `cron_runs` has no race relationship in this schema; its count is scoped to the UTC');
  lines.push('  calendar day of the requested date, which is a DIFFERENT semantic from a race meeting date.');
  lines.push('- `genai_commentary.race_id` is nullable; rows with no race link cannot be date-scoped.');
  lines.push('- A single snapshot proves state at one instant. Only a before/after pair can prove a zero delta.');
  lines.push('- Categories reported as missing/failed are never treated as zero and cannot support a PASS.');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(evidence.statement);
  lines.push('');
  lines.push('Decision-support only — no betting, no bet placement.');
  lines.push('');
  return lines.join('\n');
}

export function renderComparisonConsole(comparison: WriteBoundaryComparison): string[] {
  const lines: string[] = [];
  lines.push(`Nationwide write-boundary comparison — ${comparison.date}`);
  lines.push('READ ONLY — local evidence files only; no database query, provider call or claim operation.');
  lines.push('');
  lines.push(`Verdict: ${comparison.verdict}`);
  lines.push('');
  if (comparison.structural_failures.length > 0) {
    lines.push('Structural failures:');
    for (const f of comparison.structural_failures) lines.push(`  - ${f}`);
    lines.push('');
  }
  lines.push('Forbidden persistence (must be zero delta):');
  for (const c of comparison.categories.filter((c) => c.kind === 'forbidden')) {
    lines.push(
      `  [${c.verdict}] ${c.label.padEnd(32)} ${c.before_count ?? c.before_status} -> ${c.after_count ?? c.after_status}` +
        `${c.delta !== null ? ` (delta ${c.delta >= 0 ? '+' : ''}${c.delta})` : ''}`,
    );
    lines.push(`          ${c.explanation}`);
  }
  lines.push('');
  lines.push('Allowed ingestion (increases expected):');
  for (const c of comparison.categories.filter((c) => c.kind === 'allowed')) {
    lines.push(
      `  [${c.verdict}] ${c.label.padEnd(32)} ${c.before_count ?? c.before_status} -> ${c.after_count ?? c.after_status}` +
        `${c.delta !== null ? ` (delta ${c.delta >= 0 ? '+' : ''}${c.delta})` : ''}`,
    );
  }
  if (comparison.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of comparison.warnings) lines.push(`  - ${w}`);
  }
  lines.push('');
  lines.push(comparison.statement);
  return lines;
}

export function renderComparisonMarkdown(comparison: WriteBoundaryComparison): string {
  const lines: string[] = [];
  lines.push(`# Nationwide write-boundary comparison — ${comparison.date}`);
  lines.push('');
  lines.push(`Generated: ${comparison.generated_at}`);
  lines.push('');
  lines.push('**READ ONLY.** This comparison read two local evidence files only.');
  lines.push('');
  lines.push(`## Verdict: ${comparison.verdict}`);
  lines.push('');
  if (comparison.structural_failures.length > 0) {
    lines.push('### Structural failures');
    lines.push('');
    for (const f of comparison.structural_failures) lines.push(`- ${f}`);
    lines.push('');
  }
  lines.push('## Forbidden persistence (zero delta required)');
  lines.push('');
  lines.push('| Verdict | Category | Table | Before | After | Delta | Explanation |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const c of comparison.categories.filter((c) => c.kind === 'forbidden')) {
    lines.push(
      `| ${c.verdict} | ${c.label} | \`${c.table}\` | ${c.before_count ?? c.before_status} | ${c.after_count ?? c.after_status} | ${c.delta ?? 'n/a'} | ${c.explanation} |`,
    );
  }
  lines.push('');
  lines.push('## Allowed ingestion (increases expected)');
  lines.push('');
  lines.push('| Verdict | Category | Table | Before | After | Delta |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const c of comparison.categories.filter((c) => c.kind === 'allowed')) {
    lines.push(
      `| ${c.verdict} | ${c.label} | \`${c.table}\` | ${c.before_count ?? c.before_status} | ${c.after_count ?? c.after_status} | ${c.delta ?? 'n/a'} |`,
    );
  }
  lines.push('');
  lines.push('## Warnings');
  lines.push('');
  if (comparison.warnings.length === 0) lines.push('None.');
  else for (const w of comparison.warnings) lines.push(`- ${w}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(comparison.statement);
  lines.push('');
  lines.push('Decision-support only — no betting, no bet placement.');
  lines.push('');
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Deterministic report paths + input validation                              */
/* -------------------------------------------------------------------------- */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Strict `YYYY-MM-DD` calendar-date validation (round-trips). Pure. */
export function isValidEvidenceDate(date: string | null | undefined): boolean {
  if (!date || !ISO_DATE_RE.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/** Returns the label only when it is exactly `before` or `after`. Pure. */
export function parseSnapshotLabel(raw: string | null | undefined): SnapshotLabel | null {
  if (raw === 'before' || raw === 'after') return raw;
  return null;
}

export function buildWriteBoundaryMarkdownPath(date: string, label: SnapshotLabel): string {
  return `reports/nationwide-write-boundary-${date}-${label}.md`;
}

export function buildWriteBoundaryJsonPath(date: string, label: SnapshotLabel): string {
  return `reports/nationwide-write-boundary-${date}-${label}.json`;
}

export function buildComparisonMarkdownPath(date: string): string {
  return `reports/nationwide-write-boundary-${date}-comparison.md`;
}

/** The UTC calendar-day bounds for a date, used for the cron telemetry scope. Pure. */
export function utcDayBounds(date: string): { fromIso: string; toIso: string } {
  const from = new Date(`${date}T00:00:00.000Z`);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

/* -------------------------------------------------------------------------- */
/* Error handling — classification + redaction                                */
/* -------------------------------------------------------------------------- */

/**
 * Patterns that must NEVER reach a report or the console. A database driver
 * error can embed a connection string, a bearer token or an API key, so the
 * raw error object is never rendered — only a short, scrubbed message.
 */
const SECRET_KEYWORD = '(?:bearer|api[_-]?key|authorization|token|secret|password|passwd|pwd|service_role|anon_key)';

const SECRET_PATTERNS: readonly RegExp[] = [
  // A credential keyword (even embedded in a longer name such as CRON_SECRET),
  // optionally repeated ("authorization: Bearer <value>"), plus its value.
  new RegExp(`(?:[\\w-]*${SECRET_KEYWORD}[\\w-]*\\s*[:=]?\\s*)+\\S*`, 'gi'),
  /\beyJ[A-Za-z0-9._-]{10,}/g, // JWT-shaped values (Supabase keys are JWTs)
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, // any URL, which may carry credentials
  /\bsb[ph]_[A-Za-z0-9_-]{8,}/g, // Supabase publishable/secret key prefixes
];

const MAX_DETAIL_LENGTH = 160;

/**
 * Produces a short, secret-free description of a query failure. Never returns
 * the driver's error object, environment values, headers or credentials. Pure.
 */
export function redactErrorDetail(error: { code?: string | null; message?: string | null } | null | undefined): string {
  if (!error) return 'unknown error';
  let message = typeof error.message === 'string' ? error.message : '';
  for (const pattern of SECRET_PATTERNS) {
    message = message.replace(pattern, '[redacted]');
  }
  message = message.replace(/\s+/g, ' ').trim();
  if (message.length > MAX_DETAIL_LENGTH) message = `${message.slice(0, MAX_DETAIL_LENGTH)}…`;
  const code = typeof error.code === 'string' && error.code.trim() !== '' ? error.code.trim() : null;
  if (code && message) return `${code}: ${message}`;
  if (code) return code;
  return message || 'unknown error';
}

/** Redacts an owner id to a short, non-identifying prefix. Pure. */
export function ownerPrefix(ownerId: string | null | undefined): string | null {
  if (typeof ownerId !== 'string' || ownerId.trim() === '') return null;
  return ownerId.trim().slice(0, 8);
}

const PERMISSION_DENIED_CODE = '42501';

/**
 * Maps a query error to a category status. A missing table, a permission
 * failure and any other error are DISTINCT states — none of them becomes a
 * zero count. `tableClassifier` is injected so this stays pure and testable.
 * Pure.
 */
export function classifyCategoryError(
  error: { code?: string | null; message?: string | null } | null | undefined,
  tableClassifier: (e: { code?: string | null; message?: string | null } | null | undefined) => 'present' | 'missing' | 'indeterminate',
): { status: CategoryStatus; detail: string } {
  const detail = redactErrorDetail(error);
  if (!error) return { status: 'counted', detail };
  if (tableClassifier(error) === 'missing') {
    return { status: 'table_missing', detail };
  }
  const code = typeof error.code === 'string' ? error.code : '';
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
  if (code === PERMISSION_DENIED_CODE || message.includes('permission denied')) {
    return { status: 'permission_denied', detail };
  }
  return { status: 'query_failed', detail };
}

/* -------------------------------------------------------------------------- */
/* SELECT-only gathering (over an injected read seam)                         */
/* -------------------------------------------------------------------------- */

export interface PgErrorLike {
  code?: string | null;
  message?: string | null;
}

export interface RaceRowForBoundary {
  id: string;
  course: string | null;
  status: string | null;
}

/** Extra SELECT filters the gatherer needs beyond the id-list restriction. */
export interface CountFilters {
  /** Only count rows where this column IS NOT NULL. */
  notNullColumn?: string;
}

/**
 * The ONLY database surface this evidence pack uses. Every method is a SELECT.
 * There is deliberately no insert/update/upsert/delete/rpc-mutation member —
 * a write is not expressible through this interface.
 */
export interface WriteBoundaryReadSeam {
  /** `select id, course, status from races where meeting_date = <date>`. */
  fetchRaces(date: string): Promise<{ rows: RaceRowForBoundary[] | null; error: PgErrorLike | null }>;
  /** `select count(*) from <table> where <column> in (<ids>)` (+ optional filters). */
  countByIds(
    table: string,
    column: string,
    ids: readonly string[],
    filters?: CountFilters,
  ): Promise<{ count: number | null; error: PgErrorLike | null }>;
  /** `select <idColumn> from <table> where <column> in (<ids>)` — two-hop scoping. */
  fetchIdsByIds(
    table: string,
    idColumn: string,
    column: string,
    ids: readonly string[],
  ): Promise<{ ids: string[] | null; error: PgErrorLike | null }>;
  /** `select count(*) from <table> where <column> >= from and <column> < to`. */
  countByTimeRange(
    table: string,
    column: string,
    fromIso: string,
    toIso: string,
  ): Promise<{ count: number | null; error: PgErrorLike | null }>;
  /** Producer claim ownership READ (the status RPC only — an observation). */
  claimStatus(date: string): Promise<ClaimEvidence>;
}

/** Id-list chunk size, keeping each PostgREST request URL comfortably bounded. */
export const ID_CHUNK_SIZE = 150;

export function chunkIds(ids: readonly string[], size = ID_CHUNK_SIZE): string[][] {
  if (size <= 0) throw new Error('chunk size must be positive');
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size) as string[]);
  return out;
}

type TableClassifier = (e: PgErrorLike | null | undefined) => 'present' | 'missing' | 'indeterminate';

/** Sums a chunked id-scoped count. A chunk error aborts and is classified. */
async function countAcrossChunks(
  seam: WriteBoundaryReadSeam,
  table: string,
  column: string,
  ids: readonly string[],
  classifier: TableClassifier,
  filters?: CountFilters,
): Promise<RawCategoryResult> {
  if (ids.length === 0) {
    return { status: 'counted', count: 0, detail: 'no date-scoped parent rows exist, so no child rows can exist' };
  }
  let total = 0;
  for (const chunk of chunkIds(ids)) {
    const { count, error } = await seam.countByIds(table, column, chunk, filters);
    if (error) {
      const classified = classifyCategoryError(error, classifier);
      return { status: classified.status, count: null, detail: classified.detail };
    }
    if (typeof count !== 'number' || !Number.isFinite(count)) {
      return { status: 'query_failed', count: null, detail: 'the count query returned no count' };
    }
    total += count;
  }
  return { status: 'counted', count: total };
}

/** Collects the distinct ids of an intermediate hop, chunked. */
async function collectIdsAcrossChunks(
  seam: WriteBoundaryReadSeam,
  table: string,
  idColumn: string,
  column: string,
  ids: readonly string[],
  classifier: TableClassifier,
): Promise<{ ok: true; ids: string[] } | { ok: false; status: CategoryStatus; detail: string }> {
  if (ids.length === 0) return { ok: true, ids: [] };
  const collected = new Set<string>();
  for (const chunk of chunkIds(ids)) {
    const result = await seam.fetchIdsByIds(table, idColumn, column, chunk);
    if (result.error) {
      const classified = classifyCategoryError(result.error, classifier);
      return { ok: false, status: classified.status, detail: classified.detail };
    }
    for (const id of result.ids ?? []) collected.add(String(id));
  }
  return { ok: true, ids: [...collected] };
}

const RACES_UNAVAILABLE_DETAIL =
  'the date-scoped race id list could not be read, so this category cannot be scoped (NOT counted as zero)';

/**
 * Runs the whole SELECT-only snapshot over the injected seam. Performs no I/O
 * itself and never mutates anything. Returns raw results ready for
 * {@link buildWriteBoundaryEvidence}.
 */
export async function gatherWriteBoundarySnapshot(
  seam: WriteBoundaryReadSeam,
  date: string,
  label: SnapshotLabel,
  classifier: TableClassifier,
): Promise<GatheredSnapshot> {
  const warnings: string[] = [];
  const categories: Record<string, RawCategoryResult> = {};

  const raceRead = await seam.fetchRaces(date);
  let courses: RawCategoryResult;
  let raceIds: string[] = [];
  let racesAvailable = false;

  if (raceRead.error) {
    const classified = classifyCategoryError(raceRead.error, classifier);
    courses = { status: classified.status, count: null, detail: classified.detail };
    categories.stored_races = { status: classified.status, count: null, detail: classified.detail };
    categories.settled_races = { status: classified.status, count: null, detail: classified.detail };
    warnings.push('the races query failed — every race-scoped category is reported unavailable, never zero');
  } else {
    const rows = raceRead.rows ?? [];
    racesAvailable = true;
    raceIds = rows.map((r) => String(r.id));
    categories.stored_races = { status: 'counted', count: rows.length };
    categories.settled_races = {
      status: 'counted',
      count: rows.filter((r) => (r.status ?? '').trim().toLowerCase() === 'result').length,
    };
    const distinct = new Set(rows.map((r) => (r.course ?? '').trim().toLowerCase()).filter((c) => c !== ''));
    courses = { status: 'counted', count: distinct.size };
    if (rows.some((r) => !r.course || r.course.trim() === '')) {
      warnings.push('at least one stored race for the date has no course label');
    }
  }

  const unavailable = (): RawCategoryResult => ({
    status: 'query_failed',
    count: null,
    detail: RACES_UNAVAILABLE_DETAIL,
  });

  // ---- one-hop, race-scoped categories -------------------------------------
  const oneHop: { id: string; table: string; column: string; filters?: CountFilters }[] = [
    { id: 'stored_runners', table: 'runners', column: 'race_id' },
    { id: 'market_snapshots', table: 'market_snapshots', column: 'race_id' },
    { id: 'model_runs', table: 'model_runs', column: 'race_id' },
    { id: 'recommendations', table: 'recommendations', column: 'race_id' },
    { id: 'locked_race_decisions', table: 'locked_race_decisions', column: 'race_id' },
    { id: 'training_examples', table: 'ml_training_examples', column: 'race_id' },
    { id: 'genai_artifacts', table: 'genai_commentary', column: 'race_id' },
    { id: 'runner_finish_positions', table: 'runners', column: 'race_id', filters: { notNullColumn: 'finish_pos' } },
  ];
  for (const spec of oneHop) {
    categories[spec.id] = racesAvailable
      ? await countAcrossChunks(seam, spec.table, spec.column, raceIds, classifier, spec.filters)
      : unavailable();
  }

  // ---- two-hop: model_runner_scores via model_runs --------------------------
  if (!racesAvailable) {
    categories.model_runner_scores = unavailable();
  } else {
    const runIds = await collectIdsAcrossChunks(seam, 'model_runs', 'id', 'race_id', raceIds, classifier);
    categories.model_runner_scores = runIds.ok
      ? await countAcrossChunks(seam, 'model_runner_scores', 'model_run_id', runIds.ids, classifier)
      : {
          status: runIds.status,
          count: null,
          detail: `parent model_runs id list unavailable — ${runIds.detail}`,
        };
  }

  // ---- two-hop: runner_quotes via market_snapshots --------------------------
  if (!racesAvailable) {
    categories.runner_quotes = unavailable();
  } else {
    const snapshotIds = await collectIdsAcrossChunks(seam, 'market_snapshots', 'id', 'race_id', raceIds, classifier);
    categories.runner_quotes = snapshotIds.ok
      ? await countAcrossChunks(seam, 'runner_quotes', 'snapshot_id', snapshotIds.ids, classifier)
      : {
          status: snapshotIds.status,
          count: null,
          detail: `parent market_snapshots id list unavailable — ${snapshotIds.detail}`,
        };
  }

  // ---- cron telemetry: NOT race-scopable in this schema ---------------------
  const bounds = utcDayBounds(date);
  const cron = await seam.countByTimeRange('cron_runs', 'finished_at', bounds.fromIso, bounds.toIso);
  if (cron.error) {
    const classified = classifyCategoryError(cron.error, classifier);
    categories.cron_telemetry = { status: classified.status, count: null, detail: classified.detail };
  } else if (typeof cron.count !== 'number' || !Number.isFinite(cron.count)) {
    categories.cron_telemetry = { status: 'query_failed', count: null, detail: 'the count query returned no count' };
  } else {
    categories.cron_telemetry = { status: 'counted', count: cron.count };
  }
  warnings.push(
    'cron_runs has no race_id/meeting_date in this schema; its count is scoped to the UTC calendar day of the date, ' +
      'which is a different semantic from a race meeting date',
  );

  if (categories.genai_artifacts?.status === 'counted') {
    warnings.push('genai_commentary.race_id is nullable; rows with no race link cannot be date-scoped and are not counted');
  }

  const claim = await seam.claimStatus(date);

  return { date, label, courses, categories, claim, warnings };
}
