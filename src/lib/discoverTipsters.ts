/**
 * Tipster discovery + momentum ("needle") scoring.
 *
 * This module turns REAL, proofed tipster leaderboard numbers into a momentum
 * score and a model weight, deduplicating tipsters across sources and
 * auto-promoting/demoting them in the active pool.
 *
 * INTEGRITY CONTRACT — NEVER FABRICATE ROI:
 * This module only ever operates on numbers handed to it. It does not invent,
 * estimate, or interpolate any ROI / strike rate / streak. The per-platform
 * source adapters (Tipping League, The Tipster League, Betting Gods, Puntrr)
 * are intentionally left UNIMPLEMENTED: each throws until you supply real
 * fetch + parse logic (and any credentials/ToS-compliant access). They must
 * return verbatim proofed figures or nothing — they must not return guesses.
 * Until then, drive discovery with `discoverTipsters(rows)` using rows you have
 * already obtained from a real, proofed export/API.
 *
 * Scoring (per the spec):
 *   reliability   = N / (N + 400)                      where N = bets_count
 *   needle_score  = 0.45*z(longRunROI)
 *                 + 0.35*z(recentROI_30d)
 *                 + 0.20*z(streak_or_today)
 *   final_weight  = reliability * exp(needle_score)
 * where z(...) is the standard score across the cohort scored in one run.
 *
 * Persistence (verified real columns, 2026-06-12):
 *   tipster_priors(tipster_id, as_of_date) <- bets_count, wins_count,
 *     roi_bsp_gross(=longRunROI), strike_rate, reliability,
 *     prior_score(=needle_score), prior_weight(=final_weight).
 *   tipsters.is_active                      <- promote/demote flag.
 *   tipsters.notes                          <- compact JSON snapshot carrying
 *     the figures that have NO native column (recentROI_30d, per-window ROIs,
 *     streak), so the UI can show them. There is deliberately no recent-ROI
 *     column in tipster_priors; this is the honest place to keep it without a
 *     schema migration. Pre-existing human notes are preserved.
 */

import { supabaseAdmin } from './supabaseAdmin';
import { resolveCanonicalTipster, fetchTodaysRaceIds } from './raceData';

// Table names (verified against the live schema 2026-06-12). Kept local so this
// module is self-contained; they intentionally mirror raceData's constants.
const TIPSTERS_TABLE = 'tipsters';
const TIPSTER_PRIORS_TABLE = 'tipster_priors';
const TIPSTER_SELECTIONS_TABLE = 'tipster_selections';
const RUNNERS_TABLE = 'runners';

/** Needle-score weights (must sum to 1). */
export const NEEDLE_W_LONG = 0.45;
export const NEEDLE_W_RECENT = 0.35;
export const NEEDLE_W_STREAK = 0.2;

/** Reliability shrinkage constant: reliability = N / (N + K). */
export const RELIABILITY_K = 400;

/** Promotion gate: 30d ROI and reliability must both clear these. */
export const PROMOTE_ROI_30D = 0; // profitable over the last 30 days
export const PROMOTE_RELIABILITY = 0.2; // N >= 100 bets

/** Demotion gate: recent ROI decaying below this demotes from the active pool. */
export const DEMOTE_ROI_30D = -0.05; // losing > 5% over the last 30 days

/**
 * Real, proofed leaderboard figures for one tipster on one source. ROI values
 * are fractions (0.12 = +12%), settled at Betfair SP where the source provides
 * it. Every field is a number the source actually published — never derived.
 */
export interface TipsterWindowedStats {
  name: string;
  /** Source/platform key or label this row was proofed on. */
  source: string;
  affiliation?: string;
  profileUrl?: string;
  /** All-time / 365d ROI (the long-run signal). */
  longRunRoi: number;
  recentRoi90d?: number;
  /** 30d ROI (the recent-momentum signal; required). */
  recentRoi30d: number;
  /** 7d / today ROI (preferred short-window signal). */
  recentRoi7d?: number;
  /** Strike rate (win fraction) in [0, 1]. */
  strikeRate: number;
  /** Longest run of consecutive losing bets (>= 0). */
  longestLosingStreak: number;
  /** Number of settled bets backing these figures (the sample size N). */
  betsCount: number;
  /** Wins backing the figures, if published. */
  winsCount?: number;
}

/** A tipster after needle scoring (pure; no DB identity yet). */
export interface NeedleScored {
  input: TipsterWindowedStats;
  zLong: number;
  zRecent: number;
  zStreak: number;
  needleScore: number;
  reliability: number;
  finalWeight: number;
}

/**
 * Reliability shrinkage: `N / (N + K)`. Returns 0 for a non-positive sample so
 * an unproofed tipster gets no weight.
 */
export function reliabilityOf(betsCount: number, k: number = RELIABILITY_K): number {
  if (!Number.isFinite(betsCount) || betsCount <= 0) {
    return 0;
  }
  return betsCount / (betsCount + k);
}

/** Population mean + standard deviation (std uses N, not N-1). */
export function populationStats(values: number[]): { mean: number; std: number } {
  if (values.length === 0) {
    return { mean: 0, std: 0 };
  }
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return { mean, std: Math.sqrt(variance) };
}

/** Standard score; 0 when the cohort has no spread (std === 0). */
export function zScore(value: number, mean: number, std: number): number {
  return std > 0 ? (value - mean) / std : 0;
}

/**
 * The third needle signal, "streak_or_today": prefer the short-window momentum
 * (7d/today ROI) when the source published it; otherwise fall back to the
 * losing streak expressed so that a SHORTER streak scores HIGHER (`-streak`).
 */
function streakSignal(row: TipsterWindowedStats): number {
  if (typeof row.recentRoi7d === 'number' && Number.isFinite(row.recentRoi7d)) {
    return row.recentRoi7d;
  }
  return -Math.max(0, row.longestLosingStreak);
}

/**
 * Computes needle scores for a cohort. z-scores are taken across the cohort
 * passed in, so this is a relative momentum ranking for one discovery run.
 *
 * Pure: no I/O, no fabrication — every output is a deterministic function of
 * the supplied proofed numbers.
 */
export function computeNeedleScores(rows: TipsterWindowedStats[]): NeedleScored[] {
  if (rows.length === 0) {
    return [];
  }

  const longStats = populationStats(rows.map((r) => r.longRunRoi));
  const recentStats = populationStats(rows.map((r) => r.recentRoi30d));
  const streakStats = populationStats(rows.map((r) => streakSignal(r)));

  return rows.map((row) => {
    const zLong = zScore(row.longRunRoi, longStats.mean, longStats.std);
    const zRecent = zScore(row.recentRoi30d, recentStats.mean, recentStats.std);
    const zStreak = zScore(streakSignal(row), streakStats.mean, streakStats.std);
    const needleScore =
      NEEDLE_W_LONG * zLong +
      NEEDLE_W_RECENT * zRecent +
      NEEDLE_W_STREAK * zStreak;
    const reliability = reliabilityOf(row.betsCount);
    const finalWeight = reliability * Math.exp(needleScore);
    return { input: row, zLong, zRecent, zStreak, needleScore, reliability, finalWeight };
  });
}

export type ActiveAction = 'promote' | 'demote' | 'unchanged';

/**
 * Decides a tipster's active-pool membership from their recent form. Promotes
 * when 30d ROI and reliability both clear the thresholds; demotes when 30d ROI
 * decays below the floor; otherwise leaves membership unchanged (a brand-new
 * tipster with no prior state defaults to inactive until it earns promotion).
 *
 * Demotion never deletes — the tipster stays in the DB, just flagged inactive.
 */
export function classifyActive(
  current: boolean | null,
  recentRoi30d: number,
  reliability: number,
): { active: boolean; action: ActiveAction } {
  if (recentRoi30d >= PROMOTE_ROI_30D && reliability >= PROMOTE_RELIABILITY) {
    return { active: true, action: current === true ? 'unchanged' : 'promote' };
  }
  if (recentRoi30d < DEMOTE_ROI_30D) {
    return { active: false, action: current === false ? 'unchanged' : 'demote' };
  }
  return { active: current ?? false, action: 'unchanged' };
}

/**
 * A per-platform leaderboard source. `fetchLeaderboard` must return verbatim
 * proofed rows (or throw); it must never fabricate figures.
 */
export interface TipsterSource {
  key: string;
  name: string;
  fetchLeaderboard(): Promise<TipsterWindowedStats[]>;
}

/**
 * Builds an unconfigured source adapter. Calling `fetchLeaderboard` throws,
 * by design, so discovery can never run on invented numbers. Replace the body
 * with real, ToS-compliant fetch + parse logic (and credentials) to enable it.
 */
function unconfiguredSource(key: string, name: string): TipsterSource {
  return {
    key,
    name,
    async fetchLeaderboard(): Promise<TipsterWindowedStats[]> {
      throw new Error(
        `Tipster source "${name}" (${key}) is not configured. Supply real ` +
          `fetch + parse logic (and any credentials/ToS-compliant access) in ` +
          `src/lib/discoverTipsters.ts. Discovery never fabricates ROI.`,
      );
    },
  };
}

/**
 * The named proofing platforms, registered as adapters. Each is a stub that
 * REFUSES to return fabricated data until wired to a real feed.
 */
export const TIPSTER_SOURCES: TipsterSource[] = [
  unconfiguredSource('tipping_league', 'Tipping League'),
  unconfiguredSource('the_tipster_league', 'The Tipster League'),
  unconfiguredSource('betting_gods', 'Betting Gods'),
  unconfiguredSource('puntrr', 'Puntrr'),
];

/** Normalises a name for in-run dedup of as-yet-unresolved tipsters. */
function normaliseName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface DiscoverOptions {
  /** `tipster_priors.as_of_date` to write (defaults to today, UTC). */
  asOfDate?: string;
  /** When true, compute + return but write nothing (default false). */
  dryRun?: boolean;
}

export interface DiscoverResultRow {
  tipster_id: string | null;
  name: string;
  source: string;
  needleScore: number;
  finalWeight: number;
  reliability: number;
  active: boolean;
  action: ActiveAction;
  /** True when this run created a new tipster row for an unresolved name. */
  created: boolean;
}

export interface DiscoverResult {
  /** Raw rows received. */
  received: number;
  /** Distinct tipsters after cross-source dedup. */
  deduped: number;
  promoted: number;
  demoted: number;
  /** Rows written to tipster_priors (0 when dryRun). */
  written: number;
  dryRun: boolean;
  asOfDate: string;
  rows: DiscoverResultRow[];
}

/** Today's date as YYYY-MM-DD (UTC). */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Cross-source dedup: collapse rows that resolve to the same canonical tipster
 * (via {@link resolveCanonicalTipster}), and group still-unresolved rows by
 * normalised name. Within a group the MOST-PROOFED row (largest `betsCount`)
 * wins — we keep one source's real figures rather than blending (a blend would
 * be a number no source actually proofed).
 */
async function dedupeByCanonical(
  rows: TipsterWindowedStats[],
): Promise<{ key: string; tipsterId: string | null; row: TipsterWindowedStats }[]> {
  const groups = new Map<
    string,
    { tipsterId: string | null; row: TipsterWindowedStats }
  >();

  for (const row of rows) {
    const resolution = await resolveCanonicalTipster(row.name, row.affiliation);
    const tipsterId =
      resolution.tipster_id != null ? String(resolution.tipster_id) : null;
    // Resolved tipsters key on their canonical id; unresolved on the name so
    // duplicates within this run still collapse.
    const key = tipsterId ? `id:${tipsterId}` : `name:${normaliseName(row.name)}`;

    const existing = groups.get(key);
    if (!existing || row.betsCount > existing.row.betsCount) {
      groups.set(key, { tipsterId, row });
    }
  }

  return [...groups.entries()].map(([key, v]) => ({ ...v, key }));
}

/** Merges a discovery snapshot into a tipster's `notes`, preserving prior text. */
function mergeDiscoveryNote(
  existing: string | null,
  snapshot: Record<string, unknown>,
): string {
  let base: Record<string, unknown> = {};
  if (existing && existing.trim() !== '') {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === 'object') {
        base = parsed as Record<string, unknown>;
      } else {
        base = { note: existing };
      }
    } catch {
      base = { note: existing }; // preserve non-JSON human note
    }
  }
  return JSON.stringify({ ...base, discovery: snapshot });
}

/**
 * Discovers and scores tipsters from REAL proofed rows, dedupes them across
 * sources, writes the canonical figures + needle weight to `tipster_priors`,
 * and auto-promotes/demotes each in the active pool. Unresolved names create a
 * new (inactive-by-default) tipster row, so the pool grows as real tipsters are
 * found. Returns a summary; with `dryRun` it computes without writing.
 *
 * @throws if a required DB write fails.
 */
export async function discoverTipsters(
  rows: TipsterWindowedStats[],
  options: DiscoverOptions = {},
): Promise<DiscoverResult> {
  const asOfDate = options.asOfDate ?? todayUtc();
  const dryRun = options.dryRun ?? false;

  const deduped = await dedupeByCanonical(rows);
  const scored = computeNeedleScores(deduped.map((d) => d.row));

  const result: DiscoverResult = {
    received: rows.length,
    deduped: deduped.length,
    promoted: 0,
    demoted: 0,
    written: 0,
    dryRun,
    asOfDate,
    rows: [],
  };

  for (let i = 0; i < deduped.length; i++) {
    const { tipsterId: resolvedId, row } = deduped[i];
    const needle = scored[i];

    // Resolve identity: known canonical id, else create a tipster on discovery.
    let tipsterId = resolvedId;
    let currentActive: boolean | null = null;
    let existingNotes: string | null = null;
    let created = false;

    if (tipsterId) {
      const { data, error } = await supabaseAdmin
        .from(TIPSTERS_TABLE)
        .select('is_active, notes')
        .eq('id', tipsterId)
        .limit(1);
      if (error) {
        throw new Error(`Failed to read tipster ${tipsterId}: ${error.message}`);
      }
      const t = (data ?? [])[0] as { is_active: boolean | null; notes: string | null } | undefined;
      currentActive = t?.is_active ?? null;
      existingNotes = t?.notes ?? null;
    }

    const decision = classifyActive(
      currentActive,
      row.recentRoi30d,
      needle.reliability,
    );
    if (decision.action === 'promote') result.promoted++;
    if (decision.action === 'demote') result.demoted++;

    const snapshot = {
      source: row.source,
      long_run_roi: row.longRunRoi,
      recent_roi_90d: row.recentRoi90d ?? null,
      recent_roi_30d: row.recentRoi30d,
      recent_roi_7d: row.recentRoi7d ?? null,
      strike_rate: row.strikeRate,
      longest_losing_streak: row.longestLosingStreak,
      bets_count: row.betsCount,
      needle_score: needle.needleScore,
      final_weight: needle.finalWeight,
      reliability: needle.reliability,
      as_of: asOfDate,
    };

    if (!dryRun) {
      // Create the tipster on first discovery of an unresolved name.
      if (!tipsterId) {
        const { data, error } = await supabaseAdmin
          .from(TIPSTERS_TABLE)
          .insert({
            canonical_name: row.name.trim(),
            display_name: row.name.trim(),
            affiliation: row.affiliation ?? null,
            source_profile_url: row.profileUrl ?? null,
            is_active: decision.active,
            first_seen_at: new Date().toISOString(),
            last_seen_at: new Date().toISOString(),
            notes: mergeDiscoveryNote(null, snapshot),
          })
          .select('id')
          .single();
        if (error) {
          throw new Error(`Failed to create tipster "${row.name}": ${error.message}`);
        }
        tipsterId = String((data as { id: string }).id);
        created = true;
      } else {
        const { error } = await supabaseAdmin
          .from(TIPSTERS_TABLE)
          .update({
            is_active: decision.active,
            last_seen_at: new Date().toISOString(),
            notes: mergeDiscoveryNote(existingNotes, snapshot),
          })
          .eq('id', tipsterId);
        if (error) {
          throw new Error(`Failed to update tipster ${tipsterId}: ${error.message}`);
        }
      }

      // Upsert today's proofing row (PK = tipster_id, as_of_date).
      const { error: priorError } = await supabaseAdmin
        .from(TIPSTER_PRIORS_TABLE)
        .upsert(
          {
            tipster_id: tipsterId,
            as_of_date: asOfDate,
            bets_count: row.betsCount,
            wins_count: row.winsCount ?? Math.round(row.strikeRate * row.betsCount),
            roi_bsp_gross: row.longRunRoi,
            strike_rate: row.strikeRate,
            reliability: needle.reliability,
            prior_score: needle.needleScore,
            prior_weight: needle.finalWeight,
          },
          { onConflict: 'tipster_id,as_of_date' },
        );
      if (priorError) {
        throw new Error(
          `Failed to write tipster_priors for ${tipsterId}: ${priorError.message}`,
        );
      }
      result.written++;
    }

    result.rows.push({
      tipster_id: tipsterId,
      name: row.name,
      source: row.source,
      needleScore: needle.needleScore,
      finalWeight: needle.finalWeight,
      reliability: needle.reliability,
      active: decision.active,
      action: decision.action,
      created,
    });
  }

  // Strongest needles first.
  result.rows.sort((a, b) => b.finalWeight - a.finalWeight);
  return result;
}

/**
 * Runs discovery from registered sources. Each source is fetched independently;
 * an unconfigured/failing source is skipped with a warning (so one bad feed
 * cannot sink the run) rather than aborting. Pass a custom `sources` list to
 * scope the run.
 */
export async function discoverFromSources(
  sources: TipsterSource[] = TIPSTER_SOURCES,
  options: DiscoverOptions = {},
): Promise<DiscoverResult> {
  const all: TipsterWindowedStats[] = [];
  for (const source of sources) {
    try {
      const rows = await source.fetchLeaderboard();
      all.push(...rows);
    } catch (err) {
      console.warn(
        `[discoverTipsters] skipping source "${source.name}": ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  return discoverTipsters(all, options);
}

/** A tipster's pick in one of today's races (for the in-form panel). */
export interface TodaysPick {
  race_id: string;
  runner_id: string;
  horse_name: string;
}

/** An in-form tipster row for the UI panel. */
export interface InFormTipster {
  tipster_id: string;
  name: string;
  /** All-time / long-run ROI (tipster_priors.roi_bsp_gross). */
  longRunRoi: number | null;
  /** 30d ROI (from the discovery snapshot in tipsters.notes). */
  recentRoi30d: number | null;
  longestLosingStreak: number | null;
  needleScore: number | null;
  finalWeight: number | null;
  /** Today's picks for this tipster (may be empty). */
  todaysPicks: TodaysPick[];
}

interface PriorRow {
  tipster_id: string;
  as_of_date: string;
  roi_bsp_gross: number | string | null;
  prior_score: number | string | null;
  prior_weight: number | string | null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Reads the top in-form (active) tipsters by needle weight, joining their
 * latest proofing row, the discovery snapshot (for 30d ROI / streak), and any
 * picks they have for today's races. Read-only.
 *
 * @throws if a required query fails.
 */
export async function fetchInFormTipsters(limit = 10): Promise<InFormTipster[]> {
  // Active tipsters with their latest snapshot note.
  const { data: tipsterData, error: tipsterError } = await supabaseAdmin
    .from(TIPSTERS_TABLE)
    .select('id, canonical_name, display_name, notes')
    .eq('is_active', true);
  if (tipsterError) {
    throw new Error(`Failed to fetch active tipsters: ${tipsterError.message}`);
  }
  const tipsters = (tipsterData ?? []) as {
    id: string;
    canonical_name: string | null;
    display_name: string | null;
    notes: string | null;
  }[];
  if (tipsters.length === 0) {
    return [];
  }
  const tipsterIds = tipsters.map((t) => String(t.id));

  // Latest tipster_priors row per tipster (rows newest-first; first seen wins).
  const { data: priorData, error: priorError } = await supabaseAdmin
    .from(TIPSTER_PRIORS_TABLE)
    .select('tipster_id, as_of_date, roi_bsp_gross, prior_score, prior_weight')
    .in('tipster_id', tipsterIds)
    .order('as_of_date', { ascending: false });
  if (priorError) {
    throw new Error(`Failed to fetch tipster priors: ${priorError.message}`);
  }
  const latestPrior = new Map<string, PriorRow>();
  for (const p of (priorData ?? []) as PriorRow[]) {
    const id = String(p.tipster_id);
    if (!latestPrior.has(id)) {
      latestPrior.set(id, p);
    }
  }

  // Today's picks (best-effort; tipster_selections may be empty).
  const picksByTipster = new Map<string, TodaysPick[]>();
  try {
    const raceIds = await fetchTodaysRaceIds();
    if (raceIds.length > 0) {
      const { data: selData } = await supabaseAdmin
        .from(TIPSTER_SELECTIONS_TABLE)
        .select('tipster_id, race_id, runner_id')
        .in('tipster_id', tipsterIds)
        .in('race_id', raceIds);
      const sels = (selData ?? []) as {
        tipster_id: string;
        race_id: string;
        runner_id: string;
      }[];
      const runnerIds = [...new Set(sels.map((s) => String(s.runner_id)))];
      const nameByRunner = new Map<string, string>();
      if (runnerIds.length > 0) {
        const { data: runnerData } = await supabaseAdmin
          .from(RUNNERS_TABLE)
          .select('id, horse_name')
          .in('id', runnerIds);
        for (const r of (runnerData ?? []) as { id: string; horse_name: string }[]) {
          nameByRunner.set(String(r.id), r.horse_name);
        }
      }
      for (const s of sels) {
        const list = picksByTipster.get(String(s.tipster_id)) ?? [];
        list.push({
          race_id: String(s.race_id),
          runner_id: String(s.runner_id),
          horse_name: nameByRunner.get(String(s.runner_id)) ?? '(unknown)',
        });
        picksByTipster.set(String(s.tipster_id), list);
      }
    }
  } catch (err) {
    console.warn('[fetchInFormTipsters] today\u2019s picks unavailable:', err);
  }

  const inForm: InFormTipster[] = tipsters.map((t) => {
    const id = String(t.id);
    const prior = latestPrior.get(id);
    let recentRoi30d: number | null = null;
    let streak: number | null = null;
    if (t.notes) {
      try {
        const parsed = JSON.parse(t.notes) as {
          discovery?: { recent_roi_30d?: number; longest_losing_streak?: number };
        };
        recentRoi30d = num(parsed.discovery?.recent_roi_30d);
        streak = num(parsed.discovery?.longest_losing_streak);
      } catch {
        // Non-JSON note: no snapshot to read.
      }
    }
    return {
      tipster_id: id,
      name: t.display_name || t.canonical_name || '(unnamed)',
      longRunRoi: num(prior?.roi_bsp_gross),
      recentRoi30d,
      longestLosingStreak: streak,
      needleScore: num(prior?.prior_score),
      finalWeight: num(prior?.prior_weight),
      todaysPicks: picksByTipster.get(id) ?? [],
    };
  });

  // Strongest weight first; nulls last. Then cap to `limit`.
  inForm.sort((a, b) => (b.finalWeight ?? -Infinity) - (a.finalWeight ?? -Infinity));
  return inForm.slice(0, Math.max(0, limit));
}
