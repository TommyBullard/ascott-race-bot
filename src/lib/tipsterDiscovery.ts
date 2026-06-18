/**
 * Tipster Discovery Engine — orchestration + source adapters (Phase 4C).
 *
 * Wires the pure capture/scoring logic (tipsterDiscoveryScore.ts) to REAL,
 * ToS-compliant sources and to the discovery review tables. It is decision
 * support only and is bounded by three hard safety rules:
 *
 *   1. WRITES ONLY TO REVIEW TABLES. The engine writes `tipster_discovery_runs`
 *      and `tipster_discovery_candidates` and NOTHING else. It never writes
 *      `tipsters`, `tipster_priors`, or `tipster_selections`, and it never sets
 *      `is_active`. A discovered profile is a review item, never a model input.
 *   2. NEVER AUTO-ACTIVE / NEVER FABRICATES. Captured candidates are always
 *      `status: 'pending'`; metrics are carried verbatim from the source (the
 *      mapping below copies only fields the source actually published).
 *   3. RESOLVE, DON'T MERGE. A discovered name is resolved against the EXISTING
 *      canonical pool (aliases + canonical_name) only to LINK `tipster_id` for
 *      the reviewer; it never creates or activates a tipster.
 *
 * The orchestrator takes its side effects as injected deps so it is unit-testable
 * with fakes (no network, no DB); `createDiscoveryDeps` provides the real wiring.
 */

import { supabaseAdmin } from './supabaseAdmin';
import { resolveCanonicalTipster } from './raceData';
import {
  fetchRacingApiSignals,
  type FetchSignalsOptions,
} from './racingApi';
import {
  buildDiscoveryPlan,
  type DiscoveredTipsterProfile,
  type DiscoveryCandidateRow,
  type DiscoveryMetrics,
  type DiscoveryPlan,
} from './tipsterDiscoveryScore';
import type { TipsterWindowedStats } from './discoverTipsters';

const DISCOVERY_RUNS_TABLE = 'tipster_discovery_runs';
const DISCOVERY_CANDIDATES_TABLE = 'tipster_discovery_candidates';

/**
 * The stable source label for tipster signals derived from The Racing API's
 * trainer/jockey course-analysis (the one configured, real, ToS-compliant
 * source). Register + approve this label in `tipster_source_registry` before a
 * committing run is allowed to persist its candidates.
 */
export const RACING_API_DISCOVERY_SOURCE_LABEL = 'racing-api-connections';

// --- Source adapters --------------------------------------------------------

/** A discovery source: a label + a function returning verbatim profiles. */
export interface DiscoverySource {
  sourceLabel: string;
  /** Human-readable source name (for logs/provenance). */
  sourceName: string;
  /** Fetch the published profiles. Must NEVER fabricate figures (throw instead). */
  fetchProfiles(): Promise<DiscoveredTipsterProfile[]>;
}

/**
 * Maps a verbatim Racing API signal to a discovered profile. Only fields the API
 * actually reported are carried; `winnerRate` is derived ONLY when both wins and
 * the sample are present (otherwise null — never invented). `placedRate` and
 * `lastSeenDate` are not provided by the analysis endpoints, so they stay null.
 */
export function signalToProfile(
  signal: TipsterWindowedStats,
  sourceLabel: string,
): DiscoveredTipsterProfile {
  const metrics: DiscoveryMetrics = {
    sampleSize: signal.betsCount,
    strikeRate: signal.strikeRate,
    winnerRate:
      typeof signal.winsCount === 'number' &&
      typeof signal.betsCount === 'number' &&
      signal.betsCount > 0
        ? signal.winsCount / signal.betsCount
        : null,
    placedRate: null,
    roi: signal.longRunRoi,
    roiRecent: signal.recentRoi30d,
    lastSeenDate: null,
  };
  return {
    discoveredName: signal.name,
    sourceLabel,
    sourceUrl: null,
    profileUrl: signal.profileUrl ?? null,
    affiliation: signal.affiliation ?? null,
    metrics,
  };
}

/**
 * The Racing API connections source: enumerates trainers/jockeys on the cards
 * and turns their windowed course-analysis into discovered profiles. Requires
 * RACING_API_USER / RACING_API_KEY (validated lazily by the client). Never
 * fabricates — an entity with no SP-settled runs simply yields no profile.
 */
export function racingApiDiscoverySource(
  options: FetchSignalsOptions = {},
): DiscoverySource {
  return {
    sourceLabel: RACING_API_DISCOVERY_SOURCE_LABEL,
    sourceName: 'The Racing API — connections',
    async fetchProfiles(): Promise<DiscoveredTipsterProfile[]> {
      const signals = await fetchRacingApiSignals(options);
      return signals.map((s) => signalToProfile(s, RACING_API_DISCOVERY_SOURCE_LABEL));
    },
  };
}

// --- Orchestration ----------------------------------------------------------

/** Provenance metadata recorded for one discovery run. */
export interface DiscoveryRunMeta {
  sourceLabel: string;
  longWindowDays: number | null;
  recentWindowDays: number | null;
  dryRun: boolean;
}

/** Per-run counts of what capture did (or would do, when dry). */
export interface DiscoveryPersistResult {
  candidatesNew: number;
  candidatesUpdated: number;
  /** How many candidate rows were linked to an existing canonical tipster. */
  linkedToCanonical: number;
}

/** Injected side effects for one discovery run (faked in tests). */
export interface DiscoveryDeps {
  /** Resolve a raw name to an existing canonical tipster id, or null. LINK ONLY. */
  resolveCanonical: (name: string, affiliation?: string | null) => Promise<string | null>;
  /** Persist the dedup'd plan into the review tables. Skipped entirely on dry run. */
  persist: (
    plan: DiscoveryPlan,
    meta: DiscoveryRunMeta,
    resolveCanonical: DiscoveryDeps['resolveCanonical'],
  ) => Promise<DiscoveryPersistResult>;
  /** Optional progress logger. */
  log?: (line: string) => void;
}

/** Options for one discovery run. */
export interface RunDiscoveryOptions {
  /** When true (the default), compute + return but write NOTHING. */
  dryRun?: boolean;
  /** Long-run window length in days (recorded for provenance). */
  longWindowDays?: number;
  /** Recent (momentum) window length in days (recorded for provenance). */
  recentWindowDays?: number;
  /** "Now" for recency scoring (injectable for tests). */
  now?: Date;
}

/** The outcome of one discovery run. */
export interface RunDiscoveryResult {
  sourceLabel: string;
  dryRun: boolean;
  received: number;
  deduped: number;
  candidatesNew: number;
  candidatesUpdated: number;
  linkedToCanonical: number;
  rows: DiscoveryCandidateRow[];
}

/**
 * Runs discovery for ONE source: fetch verbatim profiles, build a dedup'd,
 * scored capture plan (pure), and — unless `dryRun` — persist it into the review
 * tables via the injected `persist`. Returns the plan + counts. Never writes the
 * model's tables and never activates a tipster.
 */
export async function runTipsterDiscovery(
  source: DiscoverySource,
  deps: DiscoveryDeps,
  options: RunDiscoveryOptions = {},
): Promise<RunDiscoveryResult> {
  const log = deps.log ?? (() => {});
  const dryRun = options.dryRun ?? true;
  const now = options.now ?? new Date();

  log(`discovery: source=${source.sourceLabel} (${source.sourceName}) dryRun=${dryRun}`);
  const profiles = await source.fetchProfiles();
  const plan = buildDiscoveryPlan(profiles, { now });
  log(`discovery: received ${plan.received} profile(s), ${plan.deduped} after dedup`);

  let persisted: DiscoveryPersistResult = {
    candidatesNew: 0,
    candidatesUpdated: 0,
    linkedToCanonical: 0,
  };

  if (!dryRun) {
    persisted = await deps.persist(
      plan,
      {
        sourceLabel: source.sourceLabel,
        longWindowDays: options.longWindowDays ?? null,
        recentWindowDays: options.recentWindowDays ?? null,
        dryRun,
      },
      deps.resolveCanonical,
    );
    log(
      `discovery: wrote ${persisted.candidatesNew} new + ` +
        `${persisted.candidatesUpdated} updated candidate(s) ` +
        `(${persisted.linkedToCanonical} linked to a canonical tipster)`,
    );
  } else {
    log('discovery: DRY RUN — nothing written (pass --commit to persist to review tables)');
  }

  return {
    sourceLabel: source.sourceLabel,
    dryRun,
    received: plan.received,
    deduped: plan.deduped,
    candidatesNew: persisted.candidatesNew,
    candidatesUpdated: persisted.candidatesUpdated,
    linkedToCanonical: persisted.linkedToCanonical,
    rows: plan.rows,
  };
}

// --- Real persistence (Supabase) -------------------------------------------

/** The metric/provenance columns a refresh is allowed to overwrite. */
function candidateUpdatePayload(
  row: DiscoveryCandidateRow,
  runId: string | null,
  tipsterId: string | null,
): Record<string, unknown> {
  return {
    discovery_run_id: runId,
    source_url: row.source_url,
    profile_url: row.profile_url,
    raw_affiliation: row.raw_affiliation,
    tipster_id: tipsterId,
    sample_size: row.sample_size,
    strike_rate: row.strike_rate,
    roi: row.roi,
    roi_recent: row.roi_recent,
    winner_rate: row.winner_rate,
    placed_rate: row.placed_rate,
    last_seen_date: row.last_seen_date,
    recency_days: row.recency_days,
    discovery_confidence: row.discovery_confidence,
    confidence_tier: row.confidence_tier,
    confidence_reasons: row.confidence_reasons,
    last_seen_at: new Date().toISOString(),
  };
}

/**
 * Persists a capture plan into the review tables with Supabase. Inserts a
 * `tipster_discovery_runs` provenance row, then for each candidate UPSERTS by
 * `(source_label, normalized_name)`: refreshing metrics/confidence on an existing
 * row WITHOUT touching its `status`/`reviewed_at`/`review_notes` (so an operator's
 * decision is never silently reverted), or inserting a fresh `pending` row.
 *
 * `resolveCanonical` is used ONLY to link an existing canonical `tipster_id` for
 * the reviewer; this function never creates or activates a tipster.
 *
 * @throws if a required DB write fails.
 */
export async function persistDiscoveryPlan(
  plan: DiscoveryPlan,
  meta: DiscoveryRunMeta,
  resolveCanonical: DiscoveryDeps['resolveCanonical'],
): Promise<DiscoveryPersistResult> {
  // 1. Provenance run row.
  const { data: runData, error: runError } = await supabaseAdmin
    .from(DISCOVERY_RUNS_TABLE)
    .insert({
      source_label: meta.sourceLabel,
      started_at: new Date().toISOString(),
      long_window_days: meta.longWindowDays,
      recent_window_days: meta.recentWindowDays,
      profiles_found: plan.received,
      dry_run: meta.dryRun,
    })
    .select('id')
    .single();
  if (runError) {
    throw new Error(`Failed to record discovery run: ${runError.message}`);
  }
  const runId = String((runData as { id: string }).id);

  let candidatesNew = 0;
  let candidatesUpdated = 0;
  let linkedToCanonical = 0;

  // 2. Upsert each candidate (status preserved on refresh).
  for (const row of plan.rows) {
    if (row.source_label === '' || row.normalized_name === '') continue;

    const tipsterId = await resolveCanonical(row.discovered_name, row.raw_affiliation);
    if (tipsterId) linkedToCanonical++;

    const { data: existing, error: selError } = await supabaseAdmin
      .from(DISCOVERY_CANDIDATES_TABLE)
      .select('id')
      .eq('source_label', row.source_label)
      .eq('normalized_name', row.normalized_name)
      .limit(1);
    if (selError) {
      throw new Error(`Failed to look up discovery candidate: ${selError.message}`);
    }

    const existingId = ((existing ?? [])[0] as { id: string } | undefined)?.id;
    if (existingId) {
      const { error: updError } = await supabaseAdmin
        .from(DISCOVERY_CANDIDATES_TABLE)
        .update(candidateUpdatePayload(row, runId, tipsterId))
        .eq('id', existingId);
      if (updError) {
        throw new Error(`Failed to refresh discovery candidate: ${updError.message}`);
      }
      candidatesUpdated++;
    } else {
      const { error: insError } = await supabaseAdmin
        .from(DISCOVERY_CANDIDATES_TABLE)
        .insert({
          discovery_run_id: runId,
          source_label: row.source_label,
          source_url: row.source_url,
          discovered_name: row.discovered_name,
          normalized_name: row.normalized_name,
          raw_affiliation: row.raw_affiliation,
          profile_url: row.profile_url,
          tipster_id: tipsterId,
          status: row.status, // 'pending'
          sample_size: row.sample_size,
          strike_rate: row.strike_rate,
          roi: row.roi,
          roi_recent: row.roi_recent,
          winner_rate: row.winner_rate,
          placed_rate: row.placed_rate,
          last_seen_date: row.last_seen_date,
          recency_days: row.recency_days,
          discovery_confidence: row.discovery_confidence,
          confidence_tier: row.confidence_tier,
          confidence_reasons: row.confidence_reasons,
        });
      if (insError) {
        throw new Error(`Failed to capture discovery candidate: ${insError.message}`);
      }
      candidatesNew++;
    }
  }

  // 3. Finalise the run row with the realised counts.
  const { error: finError } = await supabaseAdmin
    .from(DISCOVERY_RUNS_TABLE)
    .update({
      finished_at: new Date().toISOString(),
      candidates_new: candidatesNew,
      candidates_updated: candidatesUpdated,
    })
    .eq('id', runId);
  if (finError) {
    throw new Error(`Failed to finalise discovery run: ${finError.message}`);
  }

  return { candidatesNew, candidatesUpdated, linkedToCanonical };
}

/** Builds the real, Supabase-backed discovery deps. */
export function createDiscoveryDeps(log?: (line: string) => void): DiscoveryDeps {
  return {
    resolveCanonical: async (name: string, affiliation?: string | null) => {
      const resolution = await resolveCanonicalTipster(name, affiliation ?? undefined);
      return resolution.tipster_id != null ? String(resolution.tipster_id) : null;
    },
    persist: persistDiscoveryPlan,
    log,
  };
}
