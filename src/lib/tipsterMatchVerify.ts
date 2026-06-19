/**
 * Pure verifier: would today's tipster selections form a consensus / clear
 * NO_TIPSTER_CONSENSUS once imported?
 *
 * It REUSES the exact same {@link buildTipsterConsensus} the live model run uses
 * for its (shadow) consensus, so its verdict mirrors what `runModelForRace`
 * would compute — without running the model, changing any math, or writing
 * anything. No I/O here; the CLI fetches the data read-only and calls this.
 */

import {
  buildTipsterConsensus,
  buildTipsterModelAlignment,
  type AlignmentLabel,
} from './modelTipsterConsensus';

/** One race's inputs: its known runners + the selections matched to it. */
export interface VerifyRaceInput {
  raceId: string;
  raceName: string | null;
  offTime: string | null;
  /** The race's known (priced) runner ids. */
  runnerIds: (string | number)[];
  /** runner_id -> horse name, for display only. */
  runnerNames?: Record<string, string | null>;
  /** Tipster selections already matched to this race (by runner_id). */
  tipsterSelections: { runner_id: string | number }[];
}

export interface VerifyRunnerSupport {
  runnerId: string;
  runnerName: string | null;
  selectionCount: number;
}

export interface VerifyRaceResult {
  raceId: string;
  raceName: string | null;
  offTime: string | null;
  matchedSelections: number;
  unmatchedSelections: number;
  consensusRunnerId: string | null;
  consensusRunnerName: string | null;
  consensusSupportShare: number | null;
  supportedRunners: VerifyRunnerSupport[];
  /** The alignment label the shadow layer would record (NO_TIPSTER_CONSENSUS when no consensus). */
  alignmentLabel: AlignmentLabel;
  /** True when a consensus runner exists -> NO_TIPSTER_CONSENSUS would clear for this race. */
  consensusWouldClear: boolean;
}

export interface VerifyTipsterMatchSummary {
  date: string;
  course: string | null;
  raceCount: number;
  /** Total tipster selections matched to a known runner across all races. */
  totalMatchedSelections: number;
  /** Races where a consensus runner exists. */
  racesWithConsensus: number;
  /** Distinct (race, runner) pairs with >=1 supporting selection. */
  runnersWithSupport: number;
  /** True when at least one race would clear NO_TIPSTER_CONSENSUS. */
  noConsensusWouldClearAnyRace: boolean;
  perRace: VerifyRaceResult[];
}

/**
 * Computes, per race, whether the matched tipster selections produce a consensus
 * (and would therefore clear NO_TIPSTER_CONSENSUS). Pure; deterministic.
 */
export function summarizeTipsterMatch(
  date: string,
  course: string | null,
  races: readonly VerifyRaceInput[],
): VerifyTipsterMatchSummary {
  const perRace: VerifyRaceResult[] = races.map((race) => {
    const consensus = buildTipsterConsensus({
      runnerIds: race.runnerIds,
      tipsterSelections: race.tipsterSelections,
    });
    const alignment = buildTipsterModelAlignment({
      tipsterConsensus: { consensus_runner_id: consensus.consensus_runner_id },
    });
    const names = race.runnerNames ?? {};
    const supportedRunners: VerifyRunnerSupport[] = consensus.runner_support
      .filter((r) => r.selection_count > 0)
      .map((r) => ({
        runnerId: r.runner_id,
        runnerName: names[r.runner_id] ?? null,
        selectionCount: r.selection_count,
      }));

    return {
      raceId: race.raceId,
      raceName: race.raceName,
      offTime: race.offTime,
      matchedSelections: consensus.matched_tipster_selections,
      unmatchedSelections: consensus.unmatched_tipster_selections,
      consensusRunnerId: consensus.consensus_runner_id,
      consensusRunnerName:
        consensus.consensus_runner_id !== null ? (names[consensus.consensus_runner_id] ?? null) : null,
      consensusSupportShare: consensus.consensus_support_share,
      supportedRunners,
      alignmentLabel: alignment.alignment_label,
      consensusWouldClear: consensus.consensus_runner_id !== null,
    };
  });

  return {
    date,
    course,
    raceCount: perRace.length,
    totalMatchedSelections: perRace.reduce((sum, r) => sum + r.matchedSelections, 0),
    racesWithConsensus: perRace.filter((r) => r.consensusWouldClear).length,
    runnersWithSupport: perRace.reduce((sum, r) => sum + r.supportedRunners.length, 0),
    noConsensusWouldClearAnyRace: perRace.some((r) => r.consensusWouldClear),
    perRace,
  };
}

/** Renders the summary as deterministic text for the CLI. Pure. */
export function renderTipsterMatchSummary(summary: VerifyTipsterMatchSummary): string {
  const lines: string[] = [];
  lines.push(
    `Tipster match verification \u2014 ${summary.date}${summary.course ? ` \u00b7 ${summary.course}` : ''} (read-only)`,
  );
  lines.push('='.repeat(72));
  lines.push(`Races: ${summary.raceCount}`);
  lines.push(`Selections matched to a known runner: ${summary.totalMatchedSelections}`);
  lines.push(`Races with a tipster consensus: ${summary.racesWithConsensus}/${summary.raceCount}`);
  lines.push(`(race, runner) pairs with support: ${summary.runnersWithSupport}`);
  lines.push(
    `Would NO_TIPSTER_CONSENSUS clear on any race? ${summary.noConsensusWouldClearAnyRace ? 'YES' : 'NO'}`,
  );
  lines.push('');
  for (const r of summary.perRace) {
    const off = r.offTime ? new Date(r.offTime).toISOString().slice(11, 16) : '--:--';
    lines.push(`${off}  ${r.raceName ?? r.raceId}`);
    lines.push(
      `   matched=${r.matchedSelections} unmatched=${r.unmatchedSelections}  ` +
        `consensus=${r.consensusRunnerName ?? r.consensusRunnerId ?? 'none'}  ` +
        `alignment=${r.alignmentLabel}  clears=${r.consensusWouldClear ? 'YES' : 'no'}`,
    );
    for (const s of r.supportedRunners) {
      lines.push(`      \u2022 ${s.runnerName ?? s.runnerId}: ${s.selectionCount} selection(s)`);
    }
  }
  return lines.join('\n');
}
