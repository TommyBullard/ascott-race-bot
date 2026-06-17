/**
 * Pure helpers for SETTLING from The Racing API Free-plan daily results endpoint
 * (`/v1/results/today/free`) — the safe fallback used by scripts/autoResults.ts
 * when `/v1/results` is plan-blocked.
 *
 * This module is the DECISION + MATCHING layer for the free daily payload. It is
 * strictly read-only and pure: it parses finishing positions, pages, course
 * filtering, race↔DB and runner↔DB matching, and builds a per-race
 * {@link SettlementAudit} that is run through the SAME `evaluateSettlementSafety`
 * gate as everything else. It performs NO I/O — no database, no network, no
 * mutation — so every safety rule is unit-testable.
 *
 * NEVER FABRICATES: the free schema carries finishing `position` only — NO SP and
 * NO BSP — so sp_decimal / bsp_decimal are left untouched (null) and are never
 * invented here. A free result that is incomplete, ambiguous, unmatched, has no
 * winner, or has multiple winners fails the gate and falls back to the manual
 * CSV importer. Matching prefers stored ids (race_id / horse_id) and only uses
 * the normalised-name fallback when it is UNAMBIGUOUS.
 */

import {
  evaluateSettlementSafety,
  type ResultSourceStatus,
  type SettlementAudit,
  type SettlementSafety,
} from './autoResults';
import type { ResultFreeRace, ResultFreeRunner } from './racingApi';

/** Label for the free daily results source. */
export const FREE_RESULTS_SOURCE_LABEL = 'The Racing API /v1/results/today/free';

/** Max page size for the free endpoint (the API caps `limit` at 100). */
export const FREE_RESULTS_MAX_LIMIT = 100;

/** Off-time match tolerance: a stored off and the free off must be within 2 min. */
export const OFF_TIME_TOLERANCE_MS = 120_000;

/* -------------------------------------------------------------------------- */
/* DB row shapes (SELECT-only; the CLI reads these and passes them in)         */
/* -------------------------------------------------------------------------- */

/** A stored race (read-only) used as a match candidate. */
export interface DbRaceLite {
  id: string;
  course: string | null;
  off_time: string | null;
  race_name: string | null;
  /** Current race status (e.g. 'scheduled' | 'result'); used for idempotent settle. */
  status?: string | null;
  /** Optional stored Racing API race id (none today -> id-match dormant). */
  racing_api_race_id?: string | null;
}

/** A stored runner (read-only) used as a match candidate. */
export interface DbRunnerLite {
  id: string;
  horse_name: string | null;
  /** Optional stored Racing API horse id (none today -> name fallback). */
  horse_id?: string | null;
  /** Existing stored finishing position (guards against null-overwrite). */
  finish_pos: number | null;
}

/* -------------------------------------------------------------------------- */
/* Source-fallback + applicability decisions                                  */
/* -------------------------------------------------------------------------- */

/** True when the primary `/v1/results` status warrants the free fallback. Pure. */
export function shouldTryFreeFallback(status: ResultSourceStatus): boolean {
  return status === 'plan_blocked' || status === 'unavailable';
}

/** True when `date` is today (UTC). The free endpoint is TODAY-only. Pure. */
export function isTodayUtc(date: string, now: Date = new Date()): boolean {
  return now.toISOString().slice(0, 10) === date;
}

/* -------------------------------------------------------------------------- */
/* Position parsing                                                           */
/* -------------------------------------------------------------------------- */

/** Parses a free `position` string to a positive finishing place, else null. Pure. */
export function parseFinishPosition(position: string | null | undefined): number | null {
  if (position == null) return null;
  const t = position.trim();
  if (!/^\d+$/.test(t)) return null; // "PU", "F", "UR", "" -> not a finishing place
  const n = Number(t);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** True only when the position marks the winner (exactly "1"). Pure. */
export function isWinnerPosition(position: string | null | undefined): boolean {
  return (position ?? '').trim() === '1';
}

/* -------------------------------------------------------------------------- */
/* Pagination                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Whether another page of free results should be fetched: stop when the last
 * page was empty, returned fewer than the page size, or we have already covered
 * `total`. Pure (the CLI runs the actual loop). */
export function shouldFetchMoreFreeResults(p: {
  total: number;
  skip: number;
  returned: number;
  limit: number;
}): boolean {
  if (p.returned === 0) return false;
  if (p.returned < p.limit) return false;
  return p.skip + p.returned < p.total;
}

/* -------------------------------------------------------------------------- */
/* Course filtering                                                           */
/* -------------------------------------------------------------------------- */

/** Filters free races to those whose course matches (normalised). Pure. */
export function filterFreeRacesByCourse(
  races: readonly ResultFreeRace[],
  course: string | null | undefined,
  normalizeCourse: (course: string) => string,
): ResultFreeRace[] {
  if (!course || course.trim() === '') return [...races];
  const want = normalizeCourse(course);
  return races.filter((r) => normalizeCourse(r.course ?? '') === want);
}

/* -------------------------------------------------------------------------- */
/* Race + runner matching                                                     */
/* -------------------------------------------------------------------------- */

/** Result of matching a free race to the stored races. */
export interface RaceMatchResult {
  race: DbRaceLite | null;
  ambiguous: boolean;
}

/**
 * Matches a free race to a stored race: by stored Racing API race id first (when
 * present), else by course + off-time within {@link OFF_TIME_TOLERANCE_MS}. More
 * than one candidate -> ambiguous (no match). Pure.
 */
export function matchFreeRaceToDbRace(
  free: ResultFreeRace,
  dbRaces: readonly DbRaceLite[],
  normalizeCourse: (course: string) => string,
  toleranceMs: number = OFF_TIME_TOLERANCE_MS,
): RaceMatchResult {
  if (free.race_id) {
    const byId = dbRaces.filter((r) => r.racing_api_race_id != null && r.racing_api_race_id === free.race_id);
    if (byId.length === 1) return { race: byId[0], ambiguous: false };
    if (byId.length > 1) return { race: null, ambiguous: true };
  }
  const wantCourse = normalizeCourse(free.course ?? '');
  const freeMs = Date.parse(free.off_dt ?? '');
  const candidates = dbRaces.filter((r) => {
    if (normalizeCourse(r.course ?? '') !== wantCourse) return false;
    const dbMs = Date.parse(r.off_time ?? '');
    if (Number.isNaN(freeMs) || Number.isNaN(dbMs)) return false;
    return Math.abs(freeMs - dbMs) <= toleranceMs;
  });
  if (candidates.length === 1) return { race: candidates[0], ambiguous: false };
  if (candidates.length > 1) return { race: null, ambiguous: true };
  return { race: null, ambiguous: false };
}

/** How a free runner was matched to a stored runner. */
export type RunnerMatchMethod = 'horse_id' | 'horse_name' | 'unmatched' | 'ambiguous';

/** Result of matching a free runner to the stored runners. */
export interface RunnerMatchResult {
  runner: DbRunnerLite | null;
  method: RunnerMatchMethod;
}

/**
 * Matches a free runner to a stored runner: by stored horse id first (when both
 * sides carry it), else by normalised horse name but ONLY when exactly one stored
 * runner matches. Zero -> unmatched; more than one -> ambiguous. Pure.
 */
export function matchFreeRunnerToDbRunner(
  free: ResultFreeRunner,
  dbRunners: readonly DbRunnerLite[],
  normalizeHorseName: (name: string) => string,
): RunnerMatchResult {
  if (free.horse_id) {
    const byId = dbRunners.filter((r) => r.horse_id != null && r.horse_id === free.horse_id);
    if (byId.length === 1) return { runner: byId[0], method: 'horse_id' };
    if (byId.length > 1) return { runner: null, method: 'ambiguous' };
  }
  const key = normalizeHorseName(free.horse ?? '');
  if (key === '') return { runner: null, method: 'unmatched' };
  const byName = dbRunners.filter((r) => normalizeHorseName(r.horse_name ?? '') === key);
  if (byName.length === 1) return { runner: byName[0], method: 'horse_name' };
  if (byName.length > 1) return { runner: null, method: 'ambiguous' };
  return { runner: null, method: 'unmatched' };
}

/* -------------------------------------------------------------------------- */
/* Per-race settlement                                                        */
/* -------------------------------------------------------------------------- */

/** What a commit would do for a matched runner's finishing place. */
export type CommitOp = 'update' | 'noop' | 'conflict' | 'skip';

/** A free runner mapped to a stored runner, with its parsed finishing place. */
export interface FreeRunnerResult {
  free_horse: string | null;
  free_horse_id: string | null;
  position: string | null;
  finish_pos: number | null;
  /** SP/BSP are NEVER provided by the free schema -> always null (no fabrication). */
  sp_decimal: null;
  bsp_decimal: null;
  matched_runner_id: string | null;
  match_method: RunnerMatchMethod;
  /** Existing stored finishing place for the matched runner (null if none). */
  existing_finish_pos: number | null;
  /** update = set a null; noop = identical; conflict = differs; skip = nothing to write. */
  commit_op: CommitOp;
}

/** A per-race settlement built from a free result + the stored race/runners. */
export interface FreeRaceSettlement {
  free_race_id: string | null;
  race_name: string | null;
  off_time: string | null;
  matched_db_race_id: string | null;
  ambiguous_race: boolean;
  runners: FreeRunnerResult[];
  audit: SettlementAudit;
  safety: SettlementSafety;
  /** First blocker (or ambiguity reason) when this race cannot be settled. */
  pending_reason: string | null;
}

/**
 * Builds a per-race settlement audit from one free result + its (already matched)
 * stored race and runners. Maps finishing positions, counts unmatched / ambiguous
 * runners, detects no-winner / multiple-winner / partial / null-overwrite, and
 * runs the shared safety gate. SP/BSP are left null. Pure; never writes.
 *
 * Pass `dbRace = null` with `ambiguousRace = true` when the free race matched more
 * than one stored race (so it is refused as unmatched/ambiguous).
 */
export function buildFreeRaceSettlement(
  free: ResultFreeRace,
  dbRace: DbRaceLite | null,
  dbRunners: readonly DbRunnerLite[],
  normalizeHorseName: (name: string) => string,
  ambiguousRace = false,
): FreeRaceSettlement {
  const runners: FreeRunnerResult[] = [];
  let unmatchedRunners = 0;
  let ambiguousRows = 0;
  let winners = 0;
  let positionsPresent = 0;
  let overwriteNonNullWithNull = false;
  let conflictRows = 0;

  for (const fr of free.runners ?? []) {
    const finishPos = parseFinishPosition(fr.position);
    if (finishPos != null) positionsPresent += 1;
    if (isWinnerPosition(fr.position)) winners += 1;

    let matched: DbRunnerLite | null = null;
    let method: RunnerMatchMethod = 'unmatched';
    if (dbRace) {
      const m = matchFreeRunnerToDbRunner(fr, dbRunners, normalizeHorseName);
      matched = m.runner;
      method = m.method;
      if (method === 'ambiguous') ambiguousRows += 1;
      else if (method === 'unmatched' && finishPos != null) unmatchedRunners += 1;
      if (matched && matched.finish_pos != null && finishPos == null) overwriteNonNullWithNull = true;
    }

    // Classify the commit operation vs the existing stored finishing place.
    const existingFinishPos = matched ? matched.finish_pos : null;
    let commitOp: CommitOp = 'skip';
    if (matched && finishPos != null) {
      if (existingFinishPos == null) commitOp = 'update';
      else if (existingFinishPos === finishPos) commitOp = 'noop';
      else commitOp = 'conflict';
    }
    if (commitOp === 'conflict') conflictRows += 1;

    runners.push({
      free_horse: fr.horse ?? null,
      free_horse_id: fr.horse_id ?? null,
      position: fr.position ?? null,
      finish_pos: finishPos,
      sp_decimal: null,
      bsp_decimal: null,
      matched_runner_id: matched ? matched.id : null,
      match_method: method,
      existing_finish_pos: existingFinishPos,
      commit_op: commitOp,
    });
  }

  const hasRunners = (free.runners ?? []).length > 0;
  const partial = !hasRunners || positionsPresent === 0;

  const audit: SettlementAudit = {
    source_status: 'available',
    results_official_confirmed: !partial,
    partial,
    unmatched_races: dbRace ? 0 : 1,
    unmatched_runners: unmatchedRunners,
    ambiguous_rows: ambiguousRows,
    has_winner: winners >= 1,
    duplicate_winner_conflict: winners > 1,
    would_overwrite_nonnull_with_null: overwriteNonNullWithNull,
    existing_result_conflict: conflictRows > 0,
  };
  const safety = evaluateSettlementSafety(audit);

  const pending_reason = ambiguousRace
    ? 'free result matched more than one stored race (ambiguous)'
    : safety.canCommit
      ? null
      : (safety.blockers[0] ?? null);

  return {
    free_race_id: free.race_id ?? null,
    race_name: free.race_name ?? null,
    off_time: free.off_dt ?? free.off ?? null,
    matched_db_race_id: dbRace ? dbRace.id : null,
    ambiguous_race: ambiguousRace,
    runners,
    audit,
    safety,
    pending_reason,
  };
}

/** The runner-level write plan derived from a settlement (pure). */
export interface CommitOps {
  /** Runners to write: existing finish_pos was null and the incoming is set. */
  updates: { runner_id: string; finish_pos: number }[];
  /** Matched runners whose existing finish_pos already equals the incoming. */
  noops: number;
  /** Matched runners whose existing finish_pos conflicts with the incoming. */
  conflicts: number;
}

/**
 * Derives the idempotent runner write plan for a settlement: only `update` ops
 * (existing null -> set) are written; `noop` ops are already correct; `conflict`
 * ops block the race (via the gate) and are never written. SP/BSP are never
 * included. Pure; computes nothing the audit did not already classify.
 */
export function commitOpsForSettlement(settlement: FreeRaceSettlement): CommitOps {
  const updates: { runner_id: string; finish_pos: number }[] = [];
  let noops = 0;
  let conflicts = 0;
  for (const r of settlement.runners) {
    if (r.commit_op === 'update' && r.matched_runner_id && r.finish_pos != null) {
      updates.push({ runner_id: r.matched_runner_id, finish_pos: r.finish_pos });
    } else if (r.commit_op === 'noop') {
      noops += 1;
    } else if (r.commit_op === 'conflict') {
      conflicts += 1;
    }
  }
  return { updates, noops, conflicts };
}

/* -------------------------------------------------------------------------- */
/* Full free-results report                                                   */
/* -------------------------------------------------------------------------- */

/** A stored race for which no free result was available yet. */
export interface PendingDbRace {
  id: string;
  race_name: string | null;
  off_time: string | null;
  reason: string;
}

/**
 * Matches every free race to the stored races, builds a per-race settlement for
 * each, and lists the stored races that had NO free result yet (pending). Pure:
 * the caller does the I/O (fetch free results + SELECT the stored races) and
 * passes everything in; this just matches + audits. */
export function collectFreeSettlements(params: {
  freeRaces: readonly ResultFreeRace[];
  dbRaces: readonly DbRaceLite[];
  runnersByRace: ReadonlyMap<string, readonly DbRunnerLite[]>;
  normalizeCourse: (course: string) => string;
  normalizeHorseName: (name: string) => string;
}): { settlements: FreeRaceSettlement[]; pending: PendingDbRace[] } {
  const matchedDbIds = new Set<string>();
  const settlements: FreeRaceSettlement[] = [];
  for (const free of params.freeRaces) {
    const m = matchFreeRaceToDbRace(free, params.dbRaces, params.normalizeCourse);
    if (m.race) matchedDbIds.add(m.race.id);
    const dbRunners = m.race ? (params.runnersByRace.get(m.race.id) ?? []) : [];
    settlements.push(buildFreeRaceSettlement(free, m.race, dbRunners, params.normalizeHorseName, m.ambiguous));
  }
  const pending: PendingDbRace[] = params.dbRaces
    .filter((r) => !matchedDbIds.has(r.id))
    .map((r) => ({ id: r.id, race_name: r.race_name, off_time: r.off_time, reason: 'no official/free result available yet' }));
  return { settlements, pending };
}

/** The full free-results dry-run report. */
export interface FreeResultsReport {
  date: string;
  course: string | null;
  commit_requested: boolean;
  primary_source: string;
  primary_status: ResultSourceStatus;
  primary_detail: string | null;
  free_source: string;
  free_attempted: boolean;
  free_not_applicable_reason: string | null;
  free_results_found: number;
  settlements: FreeRaceSettlement[];
  pending_db_races: PendingDbRace[];
  settle_ready_count: number;
  races_blocked: number;
  /** Planned runner finish_pos writes over settle-ready races (dry-run view). */
  runner_updates_planned: number;
  /** Matched runners already correct over settle-ready races. */
  idempotent_noops: number;
  /** Conflicting runner rows across all settlements (these block their race). */
  conflict_rows: number;
  /** Races actually committed (set by the writer; 0 in dry-run). */
  races_committed: number;
  /** Runners actually updated (set by the writer; 0 in dry-run). */
  runners_committed: number;
  manual_import_command: string;
}

function offSortKey(off: string | null): number {
  if (!off) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(off);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * Assembles the free-results report from the matched settlements + the stored
 * races that had no free result. Sorts by off time for determinism, and counts
 * how many races are settle-ready (gate passed). Pure.
 */
export function buildFreeResultsReport(input: {
  date: string;
  course: string | null;
  commitRequested: boolean;
  primarySource: string;
  primaryStatus: ResultSourceStatus;
  primaryDetail: string | null;
  freeAttempted: boolean;
  freeNotApplicableReason: string | null;
  freeResultsFound: number;
  settlements: readonly FreeRaceSettlement[];
  pendingDbRaces: readonly PendingDbRace[];
  manualImportCommand: string;
  /** Actual write outcome (set by the CLI writer; omit for dry-run). */
  committedRaces?: number;
  committedRunners?: number;
}): FreeResultsReport {
  const settlements = [...input.settlements].sort((a, b) => offSortKey(a.off_time) - offSortKey(b.off_time));
  const pending = [...input.pendingDbRaces].sort((a, b) => offSortKey(a.off_time) - offSortKey(b.off_time));

  let runnerUpdatesPlanned = 0;
  let idempotentNoops = 0;
  let conflictRows = 0;
  let racesBlocked = 0;
  for (const s of settlements) {
    const ops = commitOpsForSettlement(s);
    conflictRows += ops.conflicts;
    if (s.safety.canCommit) {
      runnerUpdatesPlanned += ops.updates.length;
      idempotentNoops += ops.noops;
    } else {
      racesBlocked += 1;
    }
  }

  return {
    date: input.date,
    course: input.course,
    commit_requested: input.commitRequested,
    primary_source: input.primarySource,
    primary_status: input.primaryStatus,
    primary_detail: input.primaryDetail,
    free_source: FREE_RESULTS_SOURCE_LABEL,
    free_attempted: input.freeAttempted,
    free_not_applicable_reason: input.freeNotApplicableReason,
    free_results_found: input.freeResultsFound,
    settlements,
    pending_db_races: pending,
    settle_ready_count: settlements.filter((s) => s.safety.canCommit).length,
    races_blocked: racesBlocked,
    runner_updates_planned: runnerUpdatesPlanned,
    idempotent_noops: idempotentNoops,
    conflict_rows: conflictRows,
    races_committed: input.committedRaces ?? 0,
    runners_committed: input.committedRunners ?? 0,
    manual_import_command: input.manualImportCommand,
  };
}

const DASH = '\u2014';

/**
 * Renders the deterministic free-results dry-run summary: the primary source
 * status, the free-source attempt, a per-race breakdown (winner, mapped finishing
 * positions, settle/pending verdict + reason), the still-pending stored races, a
 * settle-ready/pending tally, and the manual CSV fallback. Pure; no I/O.
 */
export function renderFreeResultsSummary(report: FreeResultsReport): string {
  const lines: string[] = [];
  lines.push(`Automated result settlement \u2014 ${report.commit_requested ? 'COMMIT' : 'DRY RUN'} (free daily fallback)`);
  lines.push(`  date: ${report.date}`);
  lines.push(`  course: ${report.course ?? 'All'}`);
  lines.push(`  primary source: ${report.primary_source} \u2014 ${report.primary_status}`);
  if (report.primary_detail) lines.push(`    detail: ${report.primary_detail}`);
  lines.push(`  fallback source: ${report.free_source}`);

  if (!report.free_attempted) {
    lines.push(`  free fallback: not attempted ${DASH} ${report.free_not_applicable_reason ?? 'unavailable'}`);
    lines.push(`  ${'automated results unavailable \u2014 manual CSV fallback required'}`);
    lines.push(`  manual fallback: ${report.manual_import_command}`);
    return lines.join('\n');
  }

  lines.push(`  free results returned (course-filtered): ${report.free_results_found}`);

  if (report.settlements.length === 0 && report.pending_db_races.length === 0) {
    lines.push(`  matched races: ${DASH} (no stored races matched the free results)`);
  }

  for (const s of report.settlements) {
    const winner = s.runners.find((r) => r.finish_pos === 1);
    lines.push(`  race: ${s.race_name ?? DASH} (off ${s.off_time ?? DASH})`);
    lines.push(`    matched stored race: ${s.matched_db_race_id ?? DASH}`);
    lines.push(`    winner: ${winner ? `${winner.free_horse ?? DASH} (pos 1)` : DASH}`);
    lines.push(`    runners with a finishing place: ${s.runners.filter((r) => r.finish_pos != null).length}/${s.runners.length}`);
    lines.push(`    SP/BSP: ${DASH} (not provided by the free endpoint; left null)`);
    lines.push(`    unmatched_runners: ${s.audit.unmatched_runners} · ambiguous_rows: ${s.audit.ambiguous_rows} · partial: ${s.audit.partial}`);
    if (s.safety.canCommit) {
      const ops = commitOpsForSettlement(s);
      const verb = report.commit_requested ? 'committed' : 'would commit';
      lines.push(`    settle-ready: yes \u2014 ${verb} ${ops.updates.length} finish_pos update(s), ${ops.noops} idempotent no-op(s)`);
    } else {
      lines.push(`    settle-ready: no (${s.pending_reason ?? s.safety.blockers[0] ?? 'blocked'}) \u2014 not committed`);
    }
  }

  for (const p of report.pending_db_races) {
    lines.push(`  pending race: ${p.race_name ?? DASH} (off ${p.off_time ?? DASH}) \u2014 ${p.reason}`);
  }

  lines.push(
    `  summary: ${report.settlements.length} audited, ${report.settle_ready_count} settle-ready, ` +
      `${report.races_blocked} blocked, ${report.pending_db_races.length} pending`,
  );
  lines.push(
    `  commit: ${
      report.commit_requested
        ? `${report.races_committed} race(s) committed, ${report.runners_committed} runner(s) updated`
        : `${report.runner_updates_planned} update(s) planned`
    }, ${report.idempotent_noops} idempotent no-op(s), ${report.conflict_rows} conflict row(s)`,
  );
  if (report.commit_requested) {
    lines.push('  NOTE: COMMIT \u2014 wrote finish_pos for settle-ready races only; SP/BSP left null (never fabricated); pending/blocked races untouched.');
  } else {
    lines.push('  NOTE: dry-run only \u2014 no database writes; SP/BSP never fabricated. Re-run with --commit to settle the settle-ready races.');
  }
  lines.push(`  manual fallback: ${report.manual_import_command}`);
  return lines.join('\n');
}
