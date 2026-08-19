/**
 * SERVER-ONLY, SELECT-only reads for racing search.
 *
 * The only database operations in this module are `select`. There is no
 * insert, update, upsert, delete, rpc, storage write, cron call, provider call
 * or producer claim, and searching can never start a model run, an odds
 * capture, a lock or a settlement.
 *
 * WHY SEPARATE BOUNDED PROBES, NOT ONE `.or()` FILTER.
 *
 * PostgREST's `or=` syntax is a STRING that the client interpolates verbatim,
 * so user text containing a comma, a parenthesis or a dot can close one
 * condition and open another — filter injection. `.ilike(column, value)` sends
 * the value as a discrete parameter with the column and operator fixed in this
 * file, so there is nothing to inject into. The cost is one query per column;
 * each is independently `.limit`-bounded, and they run concurrently.
 *
 * It imports `supabaseAdmin` (service role), so every consumer must be a
 * server context. Nothing here returns a client, a key, an environment value or
 * a raw PostgREST error — a failed read becomes a typed, message-free outcome
 * and the detail is logged server-side.
 *
 * Decision-support only. Nothing here places, recommends or settles a bet.
 */

import { supabaseAdmin } from './supabaseAdmin';
import {
  SEARCH_PROBE_LIMIT,
  SEARCH_RACE_COLUMNS,
  type SearchRaceRow,
} from './racingSearchContract';

/** The single table search reads. Exported so a source scan can pin it. */
export const SEARCH_TABLE = 'races';

/**
 * The FIXED columns each probe filters on.
 *
 * A closed list of literals. Caller input supplies only the VALUE compared
 * against them, never the column, so no request can redirect a probe at a
 * column it was not designed for.
 */
export const SEARCH_MATCH_COLUMNS = ['course', 'course_key', 'race_name', 'race_slug'] as const;

export type SearchReadOutcome =
  | {
      kind: 'ok';
      rows: SearchRaceRow[];
      /**
       * True when a probe returned a FULL page, so matches beyond the window
       * exist and were never seen. The caller must not present such an answer
       * as complete — "no results" and "no results in the first 40" are
       * different claims.
       */
      truncated: boolean;
    }
  | { kind: 'read_failed' };

/**
 * The narrow surface the search needs, injectable for tests.
 *
 * Two SELECT-shaped methods and nothing else: a seam that cannot express a
 * write cannot accidentally acquire one, and a test never needs credentials.
 */
export interface RacingSearchReadSeam {
  /** Rows whose `column` contains `pattern` (ilike), bounded. */
  matchColumn(
    column: (typeof SEARCH_MATCH_COLUMNS)[number],
    pattern: string,
  ): Promise<{ ok: true; rows: SearchRaceRow[] } | { ok: false; rows: null }>;
  /** Rows on an exact meeting date, bounded. */
  matchMeetingDate(
    date: string,
  ): Promise<{ ok: true; rows: SearchRaceRow[] } | { ok: false; rows: null }>;
}

/**
 * Logs a read failure with SAFE context only.
 *
 * Deliberately logs neither the PostgREST message nor the SEARCH TEXT. The
 * message can quote a filter value or connection detail, and the query is
 * something a person typed — the operator gets the stage and the column, which
 * is what a failure needs, and nothing about who searched for what.
 */
function logSearchFailure(stage: string, column: string): void {
  console.error(`RACING_SEARCH_READ_FAILED stage=${stage} column=${column}`);
}

/** The live seam. Every method is a single bounded `select` and nothing else. */
export const supabaseRacingSearchSeam: RacingSearchReadSeam = {
  async matchColumn(column, pattern) {
    const { data, error } = await supabaseAdmin
      .from(SEARCH_TABLE)
      .select(SEARCH_RACE_COLUMNS)
      .ilike(column, pattern)
      /*
       * ORDERED, not arbitrary. `LIMIT` without `ORDER BY` returns whatever
       * heap order Postgres happens to produce — in practice the OLDEST stored
       * cards — so a busy course would answer a search with last season's
       * racing and omit today's entirely.
       */
      .order('meeting_date', { ascending: false })
      .order('off_time', { ascending: false, nullsFirst: false })
      .limit(SEARCH_PROBE_LIMIT);
    if (error) {
      logSearchFailure('match_column', column);
      return { ok: false, rows: null };
    }
    return { ok: true, rows: (data ?? []) as unknown as SearchRaceRow[] };
  },

  async matchMeetingDate(date) {
    const { data, error } = await supabaseAdmin
      .from(SEARCH_TABLE)
      .select(SEARCH_RACE_COLUMNS)
      .eq('meeting_date', date)
      .order('off_time', { ascending: true, nullsFirst: false })
      .limit(SEARCH_PROBE_LIMIT);
    if (error) {
      logSearchFailure('match_meeting_date', 'meeting_date');
      return { ok: false, rows: null };
    }
    return { ok: true, rows: (data ?? []) as unknown as SearchRaceRow[] };
  },
};

/** Deduplicates rows across probes by their full projected content. */
function dedupeRows(rows: readonly SearchRaceRow[]): SearchRaceRow[] {
  const seen = new Set<string>();
  const out: SearchRaceRow[] = [];
  for (const row of rows) {
    const key = [
      row.meeting_date ?? '',
      row.course ?? '',
      row.course_key ?? '',
      row.race_slug ?? '',
      row.race_name ?? '',
      row.off_time ?? '',
      // A separator that cannot occur in any of these values, so two distinct
      // rows can never collide by a field-boundary shift and be silently
      // dropped (slug 1315-a versus slug 1315 plus name -a).
    ].join(String.fromCharCode(0));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * Runs every bounded probe concurrently and merges the matching rows.
 *
 * FAILS CLOSED. If ANY probe fails the whole read is reported as failed, and
 * the caller must not present the outcome as "no results" — a partial answer
 * that looked confident would be worse than an honest error, because the user
 * would conclude the racing does not exist.
 *
 * The date probe runs only when the query IS an exact canonical date, so a
 * partial or impossible date never reaches an equality filter.
 */
export async function searchRacingRows(
  input: { pattern: string; meetingDate: string | null },
  seam: RacingSearchReadSeam = supabaseRacingSearchSeam,
): Promise<SearchReadOutcome> {
  const probes: Promise<{ ok: true; rows: SearchRaceRow[] } | { ok: false; rows: null }>[] =
    SEARCH_MATCH_COLUMNS.map((column) => seam.matchColumn(column, input.pattern));

  if (input.meetingDate !== null) {
    probes.push(seam.matchMeetingDate(input.meetingDate));
  }

  const settled = await Promise.all(probes);
  if (settled.some((result) => !result.ok)) return { kind: 'read_failed' };

  const merged: SearchRaceRow[] = [];
  // A probe returning a FULL page means the window clipped real matches.
  let truncated = false;
  for (const result of settled) {
    if (!result.ok) continue;
    if (result.rows.length >= SEARCH_PROBE_LIMIT) truncated = true;
    merged.push(...result.rows);
  }
  return { kind: 'ok', rows: dedupeRows(merged), truncated };
}
