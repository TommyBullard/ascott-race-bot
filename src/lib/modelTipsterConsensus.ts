/**
 * Observational tipster-consensus metrics (Batch H1).
 *
 * Aggregates tipster selections across a race to answer "how much support does
 * each runner have from tipsters?" \u2014 nothing more. Pure, no I/O, no side
 * effects. It does NOT influence probabilities, confidence, staking, selection,
 * ranking, or recommendations; the result is persisted as observational
 * metadata only.
 *
 * INTEGRITY: never fabricates. A selection counts toward a runner only when its
 * `runner_id` matches one of the race's known runner IDs; selections that match
 * no known runner are counted separately as `unmatched`, never forced onto a
 * runner.
 */

/** A tipster pick: which runner a tipster selected. Ids coerced to string. */
export interface TipsterConsensusSelection {
  runner_id: string | number;
  tipster_id?: string | number;
}

/** Per-runner tipster support. */
export interface RunnerSupport {
  runner_id: string;
  selection_count: number;
  /** selection_count / matched_tipster_selections; 0 when no matched selections. */
  support_share: number;
}

/** The aggregated consensus for a race. */
export interface TipsterConsensusResult {
  total_tipster_selections: number;
  matched_tipster_selections: number;
  unmatched_tipster_selections: number;
  runner_support: RunnerSupport[];
  /** Runner with the highest selection_count; null when there are no matches. */
  consensus_runner_id: string | null;
  consensus_selection_count: number;
  /** support_share of the consensus runner; null when there are no matches. */
  consensus_support_share: number | null;
}

export interface BuildTipsterConsensusInput {
  /**
   * The race's known runner IDs, in their canonical order (e.g. the priced
   * field order). Used to (a) decide which selections are "matched" and (b)
   * break consensus ties deterministically by preserving this order.
   */
  runnerIds: readonly (string | number)[];
  /** Tipster selections already loaded for the race. */
  tipsterSelections: readonly TipsterConsensusSelection[];
}

/**
 * Builds the observational {@link TipsterConsensusResult} for a race.
 *
 * - `support_share` = `selection_count / matched_tipster_selections` (0 when
 *   there are no matched selections, so there is never a divide-by-zero).
 * - `runner_support` lists EVERY known runner (in `runnerIds` order), including
 *   those with zero support, so the output ordering is stable.
 * - `consensus_runner_id` is the runner with the highest `selection_count`;
 *   ties are broken by `runnerIds` order (first wins). It is `null` when there
 *   are no matched selections.
 *
 * Selections whose `runner_id` is not in `runnerIds` are counted in
 * `unmatched_tipster_selections` only (never attributed to a runner).
 */
export function buildTipsterConsensus(
  input: BuildTipsterConsensusInput,
): TipsterConsensusResult {
  // Canonical runner order + a set membership for matching. Later duplicates in
  // runnerIds are ignored (first position wins).
  const orderedRunnerIds: string[] = [];
  const known = new Set<string>();
  for (const id of input.runnerIds) {
    const key = String(id);
    if (!known.has(key)) {
      known.add(key);
      orderedRunnerIds.push(key);
    }
  }

  const counts = new Map<string, number>();
  let matched = 0;
  let unmatched = 0;

  for (const selection of input.tipsterSelections) {
    const key = String(selection.runner_id);
    if (known.has(key)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      matched += 1;
    } else {
      unmatched += 1;
    }
  }

  const total = input.tipsterSelections.length;

  // Per-runner support in canonical order (zero-support runners included).
  const runner_support: RunnerSupport[] = orderedRunnerIds.map((runner_id) => {
    const selection_count = counts.get(runner_id) ?? 0;
    return {
      runner_id,
      selection_count,
      support_share: matched > 0 ? selection_count / matched : 0,
    };
  });

  // Consensus = highest selection_count; ties broken by canonical order (the
  // first such runner in runner_support wins, since it preserves runnerIds order).
  let consensus: RunnerSupport | null = null;
  for (const support of runner_support) {
    if (support.selection_count > 0 && (consensus === null || support.selection_count > consensus.selection_count)) {
      consensus = support;
    }
  }

  return {
    total_tipster_selections: total,
    matched_tipster_selections: matched,
    unmatched_tipster_selections: unmatched,
    runner_support,
    consensus_runner_id: consensus ? consensus.runner_id : null,
    consensus_selection_count: consensus ? consensus.selection_count : 0,
    consensus_support_share: consensus ? consensus.support_share : null,
  };
}

/** Verdict on whether the tipster consensus agrees with the model. */
export type AlignmentLabel =
  | 'NO_TIPSTER_CONSENSUS'
  | 'NO_RECOMMENDATION'
  | 'ALIGNED'
  | 'PARTIALLY_ALIGNED'
  | 'DIVERGENT';

/** Observational comparison of the tipster consensus vs the model. */
export interface TipsterModelAlignment {
  consensus_runner_id: string | null;
  recommended_runner_id: string | null;
  top_model_runner_id: string | null;
  /** consensus === recommendation; null when either id is missing. */
  consensus_matches_recommendation: boolean | null;
  /** consensus === top model runner; null when either id is missing. */
  consensus_matches_top_model: boolean | null;
  alignment_label: AlignmentLabel;
}

/** Minimal shape carrying a runner id (a scored runner / selected bet). */
export interface RunnerIdBearer {
  runner_id: string | number;
}

export interface BuildTipsterModelAlignmentInput {
  /** The Batch H1 consensus for the race. */
  tipsterConsensus: Pick<TipsterConsensusResult, 'consensus_runner_id'>;
  /** The recommended bet (`topBet`), when one exists. */
  recommendedRunner?: RunnerIdBearer | null;
  /** The top scored (rank-1) runner, when one exists. */
  topModelRunner?: RunnerIdBearer | null;
}

/** Normalises an optional runner-id bearer to a string id, or null. */
function runnerIdOrNull(bearer: RunnerIdBearer | null | undefined): string | null {
  return bearer === null || bearer === undefined ? null : String(bearer.runner_id);
}

/**
 * Builds the observational {@link TipsterModelAlignment}: does the tipster
 * consensus agree with the model's recommendation (and its top-rated runner)?
 *
 * Label precedence (first match wins):
 *   - no consensus runner            -> `NO_TIPSTER_CONSENSUS`
 *   - consensus but no recommendation -> `NO_RECOMMENDATION`
 *   - consensus === recommendation    -> `ALIGNED`
 *   - consensus === top model (not rec) -> `PARTIALLY_ALIGNED`
 *   - consensus !== recommendation    -> `DIVERGENT`
 *
 * Pure; never fabricates ids (missing inputs become `null`). The match booleans
 * are `null` when either side of the comparison is missing.
 */
export function buildTipsterModelAlignment(
  input: BuildTipsterModelAlignmentInput,
): TipsterModelAlignment {
  const consensusId = input.tipsterConsensus.consensus_runner_id ?? null;
  const recommendedId = runnerIdOrNull(input.recommendedRunner);
  const topModelId = runnerIdOrNull(input.topModelRunner);

  const matchesRecommendation =
    consensusId !== null && recommendedId !== null
      ? consensusId === recommendedId
      : null;
  const matchesTopModel =
    consensusId !== null && topModelId !== null
      ? consensusId === topModelId
      : null;

  let alignment_label: AlignmentLabel;
  if (consensusId === null) {
    alignment_label = 'NO_TIPSTER_CONSENSUS';
  } else if (recommendedId === null) {
    alignment_label = 'NO_RECOMMENDATION';
  } else if (matchesRecommendation === true) {
    alignment_label = 'ALIGNED';
  } else if (matchesTopModel === true) {
    alignment_label = 'PARTIALLY_ALIGNED';
  } else {
    alignment_label = 'DIVERGENT';
  }

  return {
    consensus_runner_id: consensusId,
    recommended_runner_id: recommendedId,
    top_model_runner_id: topModelId,
    consensus_matches_recommendation: matchesRecommendation,
    consensus_matches_top_model: matchesTopModel,
    alignment_label,
  };
}

/** The structured, human-readable consensus summary. */
export interface TipsterConsensusSummary {
  summary: string[];
  short_summary: string;
}

/** Emoji markers for the consensus summary (consistent within this module). */
const CONSENSUS_ICON = {
  info: '\u2139', // ℹ
  people: '\u{1F465}', // 👥
  ok: '\u2705', // ✅
  warning: '\u26A0', // ⚠
} as const;

/**
 * Builds a read-only, human-readable summary of the tipster consensus and its
 * alignment with the model. Pure formatting only \u2014 it never changes behaviour
 * and never fabricates data (runner IDs are shown as-is; names are not invented).
 *
 * `summary` is a deterministic list of display lines; `short_summary` is a
 * one-line headline. Percentages are formatted to 1 decimal place. Null/missing
 * fields are handled safely (e.g. no consensus -> a single "no selections" line).
 */
export function buildTipsterConsensusSummary(
  tipsterConsensus: Pick<
    TipsterConsensusResult,
    'consensus_runner_id' | 'consensus_support_share'
  >,
  tipsterModelAlignment: Pick<TipsterModelAlignment, 'alignment_label'>,
): TipsterConsensusSummary {
  const consensusId = tipsterConsensus.consensus_runner_id ?? null;
  const share = tipsterConsensus.consensus_support_share;
  const label = tipsterModelAlignment.alignment_label;

  // No consensus -> a single, safe line; nothing else to say.
  if (consensusId === null) {
    return {
      summary: [`${CONSENSUS_ICON.info} No tipster selections available`],
      short_summary: 'No tipster consensus',
    };
  }

  const summary: string[] = [];

  // Consensus line, with support % when known (1dp); omit % when unknown.
  const pct =
    typeof share === 'number' && Number.isFinite(share)
      ? `${(share * 100).toFixed(1)}% support`
      : 'support unavailable';
  summary.push(
    `${CONSENSUS_ICON.people} Tipster consensus: runner ${consensusId} with ${pct}`,
  );

  // Alignment line, derived from the label.
  switch (label) {
    case 'ALIGNED':
      summary.push(
        `${CONSENSUS_ICON.ok} Tipsters align with the model recommendation`,
      );
      break;
    case 'PARTIALLY_ALIGNED':
      summary.push(
        `${CONSENSUS_ICON.warning} Tipsters align with the top model runner but not the recommendation`,
      );
      break;
    case 'DIVERGENT':
      summary.push(
        `${CONSENSUS_ICON.warning} Tipsters prefer a different runner than the model recommendation`,
      );
      break;
    case 'NO_RECOMMENDATION':
      summary.push(
        `${CONSENSUS_ICON.info} Tipster consensus exists but no model recommendation was made`,
      );
      break;
    // NO_TIPSTER_CONSENSUS is unreachable here (consensusId !== null), but keep
    // the switch exhaustive without inventing a line.
    case 'NO_TIPSTER_CONSENSUS':
      break;
  }

  // One-line headline from the alignment verdict (with the support % where apt).
  let short_summary: string;
  const pctShort =
    typeof share === 'number' && Number.isFinite(share)
      ? `${(share * 100).toFixed(1)}% support`
      : null;
  switch (label) {
    case 'ALIGNED':
      short_summary = 'Tipsters aligned with recommendation';
      break;
    case 'PARTIALLY_ALIGNED':
      short_summary = 'Tipsters partially aligned with model';
      break;
    case 'DIVERGENT':
      short_summary = 'Tipsters divergent from recommendation';
      break;
    case 'NO_RECOMMENDATION':
      short_summary = 'Tipster consensus, no recommendation';
      break;
    default:
      short_summary = pctShort
        ? `Tipster consensus: ${pctShort}`
        : 'Tipster consensus';
      break;
  }

  return { summary, short_summary };
}


