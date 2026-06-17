/**
 * Pure helpers for the read-only "tipster intelligence audit" (scripts/tipsterAudit.ts).
 * Phase 4 of the autonomous race-day workflow.
 *
 * This module aggregates stored tipster data into a DECISION-SUPPORT diagnostic:
 * approved-selection summaries, candidate counts, correlation / de-duplication
 * checks, evidence metrics, same-day form, and model-vs-tipster divergence. It is
 * STRICTLY READ-ONLY and SHADOW: it never changes model probability, staking,
 * ranking, or tipster weighting, never makes a tipster signal model-active, never
 * approves anything, and never gives betting advice.
 *
 * Everything here is pure and deterministic: argument parsing, the report path,
 * every aggregation, and the Markdown rendering. There is no database access, no
 * network, and no mutation. Nothing is fabricated: a missing value renders as an
 * em dash (`—`) and an absent correlation group is reported as `unknown`.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DASH = '\u2014';

/** Highest finishing position counted as a "place" (top-3, the common case). */
export const PLACE_MAX_POSITION = 3;

/* -------------------------------------------------------------------------- */
/* Arguments + output path                                                    */
/* -------------------------------------------------------------------------- */

/** Parsed CLI options for the audit. */
export interface TipsterAuditArgs {
  date?: string;
  course?: string;
}

/** Parses argv (sliced past `node script`). `--date` strict YYYY-MM-DD. Pure. */
export function parseTipsterAuditArgs(argv: readonly string[]): TipsterAuditArgs {
  const args: TipsterAuditArgs = {};
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

/** Builds `reports/tipster-audit-<date>[-<course-slug>].md`. Pure. */
export function buildTipsterAuditPath(date: string, course?: string | null): string {
  const slug = (course ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `reports/tipster-audit-${date}-${slug}.md` : `reports/tipster-audit-${date}.md`;
}

/* -------------------------------------------------------------------------- */
/* Input shapes (resolved by the script, consumed here)                       */
/* -------------------------------------------------------------------------- */

/** One approved tipster selection, joined to its race + result. */
export interface AuditSelection {
  race_id: string;
  runner_id: string;
  runner_name: string | null;
  off_time: string | null;
  race_name: string | null;
  tipster_id: string | null;
  tipster_name: string | null;
  source_label: string | null;
  /**
   * Correlation/family group for the source, when such metadata exists; null
   * when unknown (no family metadata is stored — reported as "unknown").
   */
  correlation_group: string | null;
  /** Official finishing position of the selected runner, or null. */
  finish_pos: number | null;
  /** True when the race has an official result. */
  has_result: boolean;
}

/** Per-race model + tipster context for divergence analysis. */
export interface AuditRaceContext {
  race_id: string;
  off_time: string | null;
  race_name: string | null;
  winner_name: string | null;
  has_result: boolean;
  model_pick_name: string | null;
  tipster_consensus_name: string | null;
  /** Alignment label from the final pre-off run (ALIGNED/DIVERGENT/...), or null. */
  tipster_alignment_label: string | null;
}

/** Candidate review-queue summary (date-scoped where possible). */
export interface AuditCandidateSummary {
  pending: number | null;
  approved: number | null;
  rejected: number | null;
  source_labels: string[];
}

/**
 * Counts candidate rows by review status and collects the distinct source
 * labels. Unknown statuses are ignored (not counted as any state). Pure;
 * deterministic (source labels sorted).
 */
export function summarizeCandidateRows(
  rows: ReadonlyArray<{ status: string | null; source_label: string | null }>,
): AuditCandidateSummary {
  let pending = 0;
  let approved = 0;
  let rejected = 0;
  const labels = new Set<string>();
  for (const row of rows) {
    const status = (row.status ?? '').trim();
    if (status === 'pending') pending += 1;
    else if (status === 'approved') approved += 1;
    else if (status === 'rejected') rejected += 1;
    const label = (row.source_label ?? '').trim();
    if (label !== '') labels.add(label);
  }
  return { pending, approved, rejected, source_labels: [...labels].sort() };
}

/** Evidence metrics for one tipster (from stored priors); null where absent. */
export interface AuditTipsterEvidence {
  tipster_id: string;
  tipster_name: string | null;
  /** Sample size (bets recorded). */
  sample_size: number | null;
  /** ROI (net preferred, else gross), as a fraction. */
  roi: number | null;
  /** Actual-vs-expected (A/E). */
  ae: number | null;
  /** Strike rate as a fraction. */
  strike_rate: number | null;
  /** Shrinkage reliability (0..1). */
  reliability: number | null;
  as_of_date: string | null;
}

/** The full audit payload passed to {@link renderTipsterAuditMarkdown}. */
export interface TipsterAuditReport {
  date: string;
  course: string | null;
  generatedAt: string;
  selections: AuditSelection[];
  raceContexts: AuditRaceContext[];
  candidates: AuditCandidateSummary;
  evidence: AuditTipsterEvidence[];
}

/* -------------------------------------------------------------------------- */
/* Aggregations (pure)                                                        */
/* -------------------------------------------------------------------------- */

/** A label + count pair. */
export interface LabelCount {
  label: string;
  count: number;
}

/** Counts values by key, returning entries sorted by count desc then label asc. */
function countBy(values: ReadonlyArray<string | null>, unknownLabel: string): LabelCount[] {
  const counts = new Map<string, number>();
  for (const raw of values) {
    const label = raw && raw.trim() !== '' ? raw.trim() : unknownLabel;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** The approved-selections summary. */
export interface SelectionsSummary {
  total: number;
  races_covered: number;
  by_source: LabelCount[];
  by_tipster: LabelCount[];
  by_race: LabelCount[];
  unknown_source: number;
  unknown_tipster: number;
}

/** Aggregates approved selections by source / tipster / race. Pure. */
export function summarizeSelections(selections: readonly AuditSelection[]): SelectionsSummary {
  const races = new Set<string>();
  for (const s of selections) races.add(s.race_id);

  const raceLabel = (s: AuditSelection): string =>
    s.race_name && s.race_name.trim() !== '' ? s.race_name.trim() : `race ${s.race_id}`;

  return {
    total: selections.length,
    races_covered: races.size,
    by_source: countBy(
      selections.map((s) => s.source_label),
      '(unknown source)',
    ),
    by_tipster: countBy(
      selections.map((s) => s.tipster_name),
      '(unknown tipster)',
    ),
    by_race: countBy(selections.map(raceLabel), '(unknown race)'),
    unknown_source: selections.filter((s) => !s.source_label || s.source_label.trim() === '').length,
    unknown_tipster: selections.filter((s) => !s.tipster_name || s.tipster_name.trim() === '').length,
  };
}

/** A runner selected by more than one distinct source (possible double-count). */
export interface DuplicateRunnerSelection {
  race_id: string;
  runner_id: string;
  runner_name: string | null;
  race_name: string | null;
  sources: string[];
  tipsters: string[];
  /** Correlation groups seen for the sources, or `['unknown']` when none stored. */
  correlation_groups: string[];
}

/**
 * Detects runners selected by MORE THAN ONE distinct source (a possible
 * double-count of correlated signals). When no correlation-group metadata is
 * stored, the group is reported as `unknown`. Deterministic (sorted by race then
 * runner). Pure.
 */
export function detectDuplicateRunnerSelections(
  selections: readonly AuditSelection[],
): DuplicateRunnerSelection[] {
  const groups = new Map<string, AuditSelection[]>();
  for (const s of selections) {
    const key = `${s.race_id}\u0000${s.runner_id}`;
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }

  const out: DuplicateRunnerSelection[] = [];
  for (const list of groups.values()) {
    const sources = [...new Set(list.map((s) => (s.source_label ?? '').trim()).filter((x) => x !== ''))].sort();
    if (sources.length < 2) continue; // only multiple DISTINCT sources are a double-count risk
    const tipsters = [
      ...new Set(list.map((s) => (s.tipster_name ?? '').trim()).filter((x) => x !== '')),
    ].sort();
    const groupsSeen = [
      ...new Set(list.map((s) => (s.correlation_group ?? '').trim()).filter((x) => x !== '')),
    ].sort();
    const first = list[0];
    out.push({
      race_id: first.race_id,
      runner_id: first.runner_id,
      runner_name: first.runner_name,
      race_name: first.race_name,
      sources,
      tipsters,
      correlation_groups: groupsSeen.length > 0 ? groupsSeen : ['unknown'],
    });
  }
  return out.sort((a, b) => a.race_id.localeCompare(b.race_id) || a.runner_id.localeCompare(b.runner_id));
}

/** One tipster's same-day (in-day) form over already-RESULTED races only. */
export interface InDayFormRow {
  tipster: string;
  settled: number;
  won: number;
  placed: number;
  lost: number;
}

/**
 * Computes per-tipster SAME-DAY form from selections whose race has a result
 * ("earlier" races — a race only resolves after it is run). Future/unresulted
 * races are excluded. Diagnostic only: this NEVER changes weighting; any future
 * use must be capped + decayed (documented, not implemented). Pure; deterministic
 * (sorted by tipster).
 */
export function computeInDayForm(selections: readonly AuditSelection[]): InDayFormRow[] {
  const byTipster = new Map<string, InDayFormRow>();
  for (const s of selections) {
    if (!s.has_result) continue; // never use future/unresulted races
    const tipster = s.tipster_name && s.tipster_name.trim() !== '' ? s.tipster_name.trim() : '(unknown tipster)';
    const row = byTipster.get(tipster) ?? { tipster, settled: 0, won: 0, placed: 0, lost: 0 };
    row.settled += 1;
    if (s.finish_pos === 1) row.won += 1;
    else if (typeof s.finish_pos === 'number' && s.finish_pos >= 2 && s.finish_pos <= PLACE_MAX_POSITION) row.placed += 1;
    else row.lost += 1;
    byTipster.set(tipster, row);
  }
  return [...byTipster.values()].sort((a, b) => a.tipster.localeCompare(b.tipster));
}

/** Divergence tallies across the day's races. */
export interface DivergenceSummary {
  aligned: number;
  divergent: number;
  no_consensus: number;
  other: number;
}

/** Tallies model-vs-tipster alignment labels across races. Pure. */
export function summarizeDivergence(raceContexts: readonly AuditRaceContext[]): DivergenceSummary {
  const summary: DivergenceSummary = { aligned: 0, divergent: 0, no_consensus: 0, other: 0 };
  for (const r of raceContexts) {
    switch (r.tipster_alignment_label) {
      case 'ALIGNED':
        summary.aligned += 1;
        break;
      case 'DIVERGENT':
        summary.divergent += 1;
        break;
      case 'NO_TIPSTER_CONSENSUS':
        summary.no_consensus += 1;
        break;
      default:
        summary.other += 1;
    }
  }
  return summary;
}

/**
 * Builds factual recommendation lines: potential double-counting, sources/
 * tipsters lacking recorded evidence, and pending candidates to review. NO
 * betting advice and NO predictive-edge claims. Pure; deterministic.
 */
export function buildAuditRecommendations(
  duplicates: readonly DuplicateRunnerSelection[],
  evidence: readonly AuditTipsterEvidence[],
  candidates: AuditCandidateSummary,
): string[] {
  const lines: string[] = [];

  if (duplicates.length > 0) {
    lines.push(
      `Potential double-counting: ${duplicates.length} runner(s) were selected by ` +
        'multiple distinct sources. Review correlation before treating these as ' +
        'independent confirmation (correlation groups are currently unknown).',
    );
  } else {
    lines.push('No runner was selected by multiple distinct sources in scope (no double-count detected).');
  }

  const needsProof = evidence
    .filter((e) => e.sample_size === null || e.sample_size === 0)
    .map((e) => e.tipster_name && e.tipster_name.trim() !== '' ? e.tipster_name.trim() : e.tipster_id)
    .sort();
  if (needsProof.length > 0) {
    lines.push(
      `Sources/tipsters needing proof review (no recorded sample size): ${needsProof.join(', ')}.`,
    );
  } else if (evidence.length > 0) {
    lines.push('All tipsters in scope have a recorded sample size.');
  }

  if (typeof candidates.pending === 'number' && candidates.pending > 0) {
    lines.push(
      `${candidates.pending} candidate(s) pending review — review with ` +
        '`npm run review:tipster-candidates -- --list-candidates` (no auto-approval).',
    );
  }

  lines.push('Diagnostic only — not betting advice, and no predictive-edge claim is made.');
  return lines;
}

/* -------------------------------------------------------------------------- */
/* Markdown rendering (pure, deterministic)                                   */
/* -------------------------------------------------------------------------- */

function orDash(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return DASH;
  return String(value);
}

/** Formats a fraction as a signed percentage (e.g. +12.3%), or em dash. */
function fmtPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  const pct = value * 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '\u2212' : '';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/** Formats a plain number to `dp` decimals, or em dash. */
function fmtNum(value: number | null, dp: number): string {
  return value === null || !Number.isFinite(value) ? DASH : value.toFixed(dp);
}

/** Off time as HH:MM (UTC), or em dash. */
function fmtOffTimeHm(offTime: string | null): string {
  if (!offTime) return DASH;
  const ms = new Date(offTime).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 16) : DASH;
}

function renderLabelCounts(title: string, counts: readonly LabelCount[]): string {
  const lines = [`${title}:`];
  if (counts.length === 0) lines.push(`- ${DASH}`);
  else for (const c of counts) lines.push(`- ${c.label}: ${c.count}`);
  return lines.join('\n');
}

/**
 * Renders the full tipster audit as deterministic Markdown. Pure: the same
 * report object always yields the same string (`generatedAt` is verbatim).
 * Missing values render as an em dash; absent correlation groups as `unknown`.
 */
export function renderTipsterAuditMarkdown(report: TipsterAuditReport): string {
  const summary = summarizeSelections(report.selections);
  const duplicates = detectDuplicateRunnerSelections(report.selections);
  const inDayForm = computeInDayForm(report.selections);
  const divergence = summarizeDivergence(report.raceContexts);
  const recommendations = buildAuditRecommendations(duplicates, report.evidence, report.candidates);

  const blocks: string[] = [];

  blocks.push(`# Tipster intelligence audit — ${report.date}`);
  blocks.push(
    [
      `Course: ${report.course ?? 'All'}`,
      `Generated: ${report.generatedAt}`,
      `Approved selections: ${summary.total}`,
    ].join('  \n'),
  );
  blocks.push(
    [
      '> Read-only diagnostic. These tipster signals are NOT model-active, change',
      '> no probability, staking, ranking, or weighting, and approve nothing. In-day',
      '> form is diagnostic only; any future use must be capped and decayed (not',
      '> implemented here). Decision-support only — not betting advice.',
    ].join('\n'),
  );

  // 1. Approved selections summary.
  blocks.push(
    [
      '## 1. Approved selections',
      '',
      `- Total approved selections: ${summary.total}`,
      `- Races covered: ${summary.races_covered}`,
      `- Selections with unknown source: ${summary.unknown_source}`,
      `- Selections with unknown tipster: ${summary.unknown_tipster}`,
      '',
      renderLabelCounts('By source', summary.by_source),
      '',
      renderLabelCounts('By tipster', summary.by_tipster),
      '',
      renderLabelCounts('By race', summary.by_race),
    ].join('\n'),
  );

  // 2. Candidate summary.
  blocks.push(
    [
      '## 2. Candidates',
      '',
      `- Pending: ${orDash(report.candidates.pending)}`,
      `- Approved: ${orDash(report.candidates.approved)}`,
      `- Rejected: ${orDash(report.candidates.rejected)}`,
      `- Source labels: ${report.candidates.source_labels.length ? report.candidates.source_labels.join(', ') : DASH}`,
    ].join('\n'),
  );

  // 3. Correlation / de-duplication.
  const corrLines = ['## 3. Correlation / de-duplication', ''];
  if (duplicates.length === 0) {
    corrLines.push('- No runner was selected by multiple distinct sources in scope.');
  } else {
    corrLines.push(
      `- ${duplicates.length} runner(s) selected by multiple distinct sources (possible double-count):`,
    );
    for (const d of duplicates) {
      corrLines.push(
        `  - ${orDash(d.runner_name)} (${orDash(d.race_name)}): sources ${d.sources.join(', ')} · ` +
          `tipsters ${d.tipsters.length ? d.tipsters.join(', ') : DASH} · correlation group ${d.correlation_groups.join(', ')}`,
      );
    }
    corrLines.push('- ⚠️ Treat correlated/related sources as ONE signal — do not double-count them.');
  }
  blocks.push(corrLines.join('\n'));

  // 4. Tipster evidence diagnostics.
  const evLines = ['## 4. Tipster evidence', ''];
  if (report.evidence.length === 0) {
    evLines.push(`- ${DASH} (no recorded tipster evidence in scope)`);
  } else {
    evLines.push('| Tipster | Sample | ROI | A/E | Strike | Reliability | Proof | Recent form |');
    evLines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const e of [...report.evidence].sort((a, b) => (a.tipster_name ?? a.tipster_id).localeCompare(b.tipster_name ?? b.tipster_id))) {
      evLines.push(
        `| ${orDash(e.tipster_name ?? e.tipster_id)} | ${orDash(e.sample_size)} | ${fmtPct(e.roi)} | ` +
          `${fmtNum(e.ae, 2)} | ${fmtPct(e.strike_rate)} | ${fmtNum(e.reliability, 2)} | ${DASH} | ${DASH} |`,
      );
    }
    evLines.push('');
    evLines.push('Proof quality and recent-form columns are not first-class metrics yet, so they render as ' + DASH + '.');
  }
  blocks.push(evLines.join('\n'));

  // 5. In-day form diagnostics.
  const formLines = ['## 5. In-day form (diagnostic only)', ''];
  if (inDayForm.length === 0) {
    formLines.push(`- ${DASH} (no resulted same-day selections yet)`);
  } else {
    for (const f of inDayForm) {
      formLines.push(`- ${f.tipster}: ${f.won}/${f.settled} won · ${f.placed} placed · ${f.lost} lost (settled ${f.settled})`);
    }
    formLines.push('- Note: in-day form is a small sample; any future weighting must be capped and decayed. NOT applied here.');
  }
  blocks.push(formLines.join('\n'));

  // 6. Divergence analysis.
  const divLines = [
    '## 6. Divergence analysis',
    '',
    `- Races where tipster consensus ALIGNED with the model: ${divergence.aligned}`,
    `- Races where tipster consensus DIVERGED from the model: ${divergence.divergent}`,
    `- Races with NO tipster consensus: ${divergence.no_consensus}`,
    `- Other / not applicable: ${divergence.other}`,
    '',
  ];
  if (report.raceContexts.length === 0) {
    divLines.push(`- ${DASH} (no race context in scope)`);
  } else {
    divLines.push('| Off | Race | Alignment | Winner | Model pick | Tipster consensus |');
    divLines.push('| --- | --- | --- | --- | --- | --- |');
    for (const r of report.raceContexts) {
      divLines.push(
        `| ${fmtOffTimeHm(r.off_time)} | ${orDash(r.race_name)} | ${orDash(r.tipster_alignment_label)} | ` +
          `${orDash(r.winner_name)} | ${orDash(r.model_pick_name)} | ${orDash(r.tipster_consensus_name)} |`,
      );
    }
  }
  blocks.push(divLines.join('\n'));

  // 7. Recommendations (factual).
  blocks.push(['## 7. Recommendations (factual)', '', ...recommendations.map((r) => `- ${r}`)].join('\n'));

  return blocks.join('\n\n') + '\n';
}
