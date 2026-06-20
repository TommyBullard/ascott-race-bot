/**
 * RESEARCH-ONLY public-source tipster consensus (Task 6, 2026-06-20 Ascot).
 *
 * Groups manually-captured PUBLIC tipster opinions (the manual-review CSV) by
 * race + runner, counts how many distinct public sources mention each runner,
 * and lines them up against the model pick and market favourite for context.
 *
 * Strict guarantees:
 *   - PURE: no network, no scraping, no DB, no file I/O, no fabrication.
 *   - RESEARCH-ONLY: this NEVER converts a public mention into a model-active
 *     selection. It changes no probability, EV, staking, ranking, or
 *     recommendation, and places no bet.
 *   - De-duplicates syndicated rows: the same tipster appearing under more than
 *     one source label (e.g. Jon Vine via Freetips AND RacingInsider) is counted
 *     ONCE and flagged, so syndication cannot inflate apparent consensus.
 *   - Keeps PR-family duplicate protection: correlation_group = PR_family rows
 *     are flagged so a single PR network cannot masquerade as many sources.
 */

import { normalizeHorseName } from './raceSync';
import type { ManualReviewRow } from './tipsterManualReview';
import { PR_FAMILY_GROUP } from './tipsterManualReview';

/** Optional per-race context an operator can supply (model pick / favourite). */
export interface RaceConsensusContext {
  modelPickHorse?: string | null;
  marketFavouriteHorse?: string | null;
}

/** A map from raceKey() -> context. */
export type ConsensusContextMap = Record<string, RaceConsensusContext>;

/** One source mention of a runner (kept for transparency). */
export interface RunnerMention {
  source_label: string;
  tipster_name: string;
  opinion_type: string;
  pr_family: boolean;
}

/** Per-runner public-consensus summary within a race. */
export interface RunnerConsensus {
  runner_name: string;
  /** Distinct public mentions after syndication de-duplication. */
  public_mention_count: number;
  /** Raw number of CSV rows mentioning this runner (before de-dup). */
  raw_row_count: number;
  /** Distinct source labels mentioning this runner. */
  sources: string[];
  /** Distinct tipster names mentioning this runner. */
  tipsters: string[];
  /** True when one tipster was found under more than one source label. */
  syndication_duplicate: boolean;
  /** True when any mention belongs to the PR_family correlation group. */
  pr_family: boolean;
  mentions: RunnerMention[];
  matches_model_pick: boolean | null;
  matches_market_favourite: boolean | null;
  agreement: string;
}

/** Per-race grouping of the public consensus. */
export interface RaceConsensus {
  race_key: string;
  race_time: string;
  race_name: string;
  model_pick_horse: string | null;
  market_favourite_horse: string | null;
  runners: RunnerConsensus[];
  top_public_runner: string | null;
  top_public_mention_count: number;
  warnings: string[];
}

/** The full research report. */
export interface PublicConsensusReport {
  date: string;
  course: string;
  generated_at: string;
  research_only: true;
  total_rows: number;
  race_count: number;
  races: RaceConsensus[];
  notes: string[];
}

export const CONSENSUS_RESEARCH_NOTE =
  'Research-only: public-source mentions are NOT model-active and do not change ' +
  'model probability, EV, staking, ranking, or recommendations. No bets are placed.';

export const SYNDICATION_NOTE =
  'Syndicated duplicate detected: a tipster appears under more than one source ' +
  'label (e.g. Jon Vine via Freetips and RacingInsider). Counted once.';

export const PR_FAMILY_NOTE =
  'PR-family duplicate protection: correlated PR-network rows are flagged so one ' +
  'network cannot inflate apparent consensus.';

/** Stable race key from race_time + normalised race_name. Pure. */
export function raceKey(raceTime: string, raceName: string): string {
  return `${raceTime.trim()}|${raceName.trim().toLowerCase()}`;
}

function lc(value: string): string {
  return value.trim().toLowerCase();
}

function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean | null {
  if (!a || !b) return null;
  return normalizeHorseName(a) === normalizeHorseName(b);
}

function buildAgreement(
  matchesModel: boolean | null,
  matchesFav: boolean | null,
): string {
  const parts: string[] = [];
  if (matchesModel === true) parts.push('model pick');
  if (matchesFav === true) parts.push('market favourite');
  return parts.length > 0 ? `= ${parts.join(' & ')}` : '—';
}

/** Builds per-runner consensus from the rows of a single race. Pure. */
function buildRunnerConsensus(
  rows: readonly ManualReviewRow[],
  context: RaceConsensusContext,
): RunnerConsensus[] {
  const byRunner = new Map<string, ManualReviewRow[]>();
  for (const row of rows) {
    const name = row.runner_name.trim();
    if (name === '') continue;
    const key = normalizeHorseName(name);
    const list = byRunner.get(key) ?? [];
    list.push(row);
    byRunner.set(key, list);
  }

  const result: RunnerConsensus[] = [];
  for (const list of byRunner.values()) {
    const runnerName = list[0].runner_name.trim();
    const sources = [...new Set(list.map((r) => r.source_label.trim()).filter(Boolean))];
    const tipsters = [...new Set(list.map((r) => r.tipster_name.trim()).filter(Boolean))];

    // Syndication de-dup: count distinct tipsters, but if a tipster appears under
    // multiple source labels, that is one public opinion, not several.
    const sourcesByTipster = new Map<string, Set<string>>();
    for (const r of list) {
      const t = lc(r.tipster_name);
      if (t === '') continue;
      const set = sourcesByTipster.get(t) ?? new Set<string>();
      set.add(lc(r.source_label));
      sourcesByTipster.set(t, set);
    }
    let syndicationDuplicate = false;
    for (const set of sourcesByTipster.values()) {
      if (set.size > 1) syndicationDuplicate = true;
    }
    // Distinct public mentions = distinct tipsters (anonymous rows fall back to
    // distinct source labels so a nameless public source still counts once).
    const publicMentionCount =
      sourcesByTipster.size > 0 ? sourcesByTipster.size : sources.length;

    const prFamily = list.some((r) => lc(r.correlation_group) === lc(PR_FAMILY_GROUP));

    const matchesModel = namesMatch(runnerName, context.modelPickHorse ?? null);
    const matchesFav = namesMatch(runnerName, context.marketFavouriteHorse ?? null);

    result.push({
      runner_name: runnerName,
      public_mention_count: publicMentionCount,
      raw_row_count: list.length,
      sources,
      tipsters,
      syndication_duplicate: syndicationDuplicate,
      pr_family: prFamily,
      mentions: list.map((r) => ({
        source_label: r.source_label.trim(),
        tipster_name: r.tipster_name.trim(),
        opinion_type: r.opinion_type.trim(),
        pr_family: lc(r.correlation_group) === lc(PR_FAMILY_GROUP),
      })),
      matches_model_pick: matchesModel,
      matches_market_favourite: matchesFav,
      agreement: buildAgreement(matchesModel, matchesFav),
    });
  }

  // Most-mentioned first; ties broken alphabetically for determinism.
  result.sort((a, b) => {
    if (b.public_mention_count !== a.public_mention_count) {
      return b.public_mention_count - a.public_mention_count;
    }
    return a.runner_name.localeCompare(b.runner_name);
  });
  return result;
}

/** Builds the full research report from manual-review rows. Pure. */
export function buildPublicConsensusReport(input: {
  date: string;
  course: string;
  generatedAt: string;
  rows: readonly ManualReviewRow[];
  context?: ConsensusContextMap;
}): PublicConsensusReport {
  const context = input.context ?? {};

  // Group rows by race.
  const byRace = new Map<string, ManualReviewRow[]>();
  for (const row of input.rows) {
    const time = row.race_time.trim();
    const name = row.race_name.trim();
    if (time === '' && name === '') continue;
    const key = raceKey(time, name);
    const list = byRace.get(key) ?? [];
    list.push(row);
    byRace.set(key, list);
  }

  const races: RaceConsensus[] = [];
  for (const [key, rows] of byRace) {
    const time = rows[0].race_time.trim();
    const name = rows[0].race_name.trim();
    // Prefer an exact race_time+name context match; fall back to time-only so the
    // model pick / market favourite still populate when race names differ.
    const ctx = context[key] ?? context[raceKey(time, '')] ?? {};
    const runners = buildRunnerConsensus(rows, ctx);

    const warnings: string[] = [];
    if (runners.some((r) => r.syndication_duplicate)) warnings.push(SYNDICATION_NOTE);
    if (runners.some((r) => r.pr_family)) warnings.push(PR_FAMILY_NOTE);

    const top = runners[0] ?? null;
    races.push({
      race_key: key,
      race_time: time,
      race_name: name,
      model_pick_horse: ctx.modelPickHorse ?? null,
      market_favourite_horse: ctx.marketFavouriteHorse ?? null,
      runners,
      top_public_runner: top ? top.runner_name : null,
      top_public_mention_count: top ? top.public_mention_count : 0,
      warnings,
    });
  }

  // Order races by race_time (string HH:MM sorts chronologically), then name.
  races.sort((a, b) => {
    if (a.race_time !== b.race_time) return a.race_time.localeCompare(b.race_time);
    return a.race_name.localeCompare(b.race_name);
  });

  return {
    date: input.date,
    course: input.course,
    generated_at: input.generatedAt,
    research_only: true,
    total_rows: input.rows.length,
    race_count: races.length,
    races,
    notes: [CONSENSUS_RESEARCH_NOTE, SYNDICATION_NOTE, PR_FAMILY_NOTE],
  };
}

function dash(value: string | null): string {
  return value && value.trim() !== '' ? value : '—';
}

/** Renders the research report as deterministic Markdown. Pure. */
export function renderPublicConsensusMarkdown(report: PublicConsensusReport): string {
  const lines: string[] = [];
  lines.push(`# Public-source tipster consensus — ${report.course} ${report.date}`);
  lines.push('');
  lines.push('> RESEARCH ONLY. ' + CONSENSUS_RESEARCH_NOTE);
  lines.push('');
  lines.push(`Generated: ${report.generated_at}`);
  lines.push('');
  lines.push(`Races: ${report.race_count} · Source rows: ${report.total_rows}`);
  lines.push('');

  for (const race of report.races) {
    lines.push(`## ${dash(race.race_time)} ${dash(race.race_name)}`);
    lines.push('');
    lines.push(`Model pick: ${dash(race.model_pick_horse)} · Market favourite: ${dash(race.market_favourite_horse)}`);
    lines.push('');
    lines.push('| Runner | Public mentions | Sources | Model pick | Market fav | Agreement |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const r of race.runners) {
      const modelCell = r.matches_model_pick === true ? 'yes' : r.matches_model_pick === false ? 'no' : '—';
      const favCell = r.matches_market_favourite === true ? 'yes' : r.matches_market_favourite === false ? 'no' : '—';
      const sourceCell = r.sources.length > 0 ? r.sources.join('; ') : '—';
      const flags: string[] = [];
      if (r.syndication_duplicate) flags.push('⚠ syndicated');
      if (r.pr_family) flags.push('⚠ PR-family');
      const runnerCell = flags.length > 0 ? `${r.runner_name} (${flags.join(', ')})` : r.runner_name;
      lines.push(
        `| ${runnerCell} | ${r.public_mention_count} | ${sourceCell} | ${modelCell} | ${favCell} | ${r.agreement} |`,
      );
    }
    lines.push('');
    if (race.warnings.length > 0) {
      for (const w of race.warnings) lines.push(`- ${w}`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  for (const note of report.notes) lines.push(`- ${note}`);
  lines.push('');
  return lines.join('\n');
}
