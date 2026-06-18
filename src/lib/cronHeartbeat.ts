/**
 * Cron heartbeat — pure record shaping + health summary, plus a best-effort
 * recorder (Phase 5 monitoring).
 *
 * Every automated cron run records a row in `cron_runs` (job, timing, ok/failed,
 * counts, error message). This module shapes those rows and reduces recent ones
 * into the per-job last-OK / last-FAIL signals that {@link assessRaceDayHealth}
 * consumes — so a dead or failing cron is visible on the health dashboard.
 *
 * The shaping + summary are PURE and unit-testable. `recordCronRun` is the only
 * I/O and is BEST-EFFORT: it never throws, so heartbeat bookkeeping can never
 * break a cron. Secret-safe: only the error MESSAGE is stored, never values.
 * Decision-support only — nothing here affects the model or places a bet.
 */

import { supabaseAdmin } from './supabaseAdmin';
import type { CronJob } from './raceDayHealth';

export const CRON_RUNS_TABLE = 'cron_runs';

/** A `cron_runs` insert row. */
export interface CronRunRecord {
  job: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  ok: boolean;
  http_status: number | null;
  counts: Record<string, number> | null;
  error: string | null;
}

/** Coerces an unknown bag into a flat record of finite numbers (drops the rest). */
function numericCounts(counts: Record<string, unknown> | null | undefined): Record<string, number> | null {
  if (!counts || typeof counts !== 'object') return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Builds a `cron_runs` record from a run's outcome. `duration_ms` is clamped to
 * ≥ 0; the error is reduced to its message (secret-safe), counts to numbers only.
 * Pure; never throws.
 */
export function buildCronRunRecord(input: {
  job: CronJob | string;
  startedAt: Date;
  finishedAt?: Date;
  ok: boolean;
  httpStatus?: number | null;
  counts?: Record<string, unknown> | null;
  error?: unknown;
}): CronRunRecord {
  const finished = input.finishedAt ?? new Date();
  const duration = Math.max(0, finished.getTime() - input.startedAt.getTime());
  const error =
    input.error == null
      ? null
      : input.error instanceof Error
        ? input.error.message
        : String(input.error);
  return {
    job: String(input.job),
    started_at: input.startedAt.toISOString(),
    finished_at: finished.toISOString(),
    duration_ms: duration,
    ok: input.ok === true,
    http_status: typeof input.httpStatus === 'number' ? input.httpStatus : null,
    counts: numericCounts(input.counts),
    error,
  };
}

/** A recent `cron_runs` row, as read for the health summary. */
export interface CronRunRow {
  job: string;
  finished_at: string | null;
  ok: boolean | null;
}

/** Per-job heartbeat health. */
export interface CronJobHealth {
  job: string;
  lastRunMs: number | null;
  lastStatus: 'ok' | 'failed' | null;
  lastOkMs: number | null;
  lastFailMs: number | null;
}

/** The reduced heartbeat, ready to enrich {@link assessRaceDayHealth}. */
export interface CronHealthSummary {
  jobs: CronJobHealth[];
  lastCronOkMs: Record<string, number>;
  lastCronFailMs: Record<string, number>;
}

/** Parses an ISO timestamp to epoch ms, or null. */
function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Reduces recent `cron_runs` rows into per-job last-run / last-OK / last-FAIL
 * signals (newest wins). Pure; deterministic; ignores rows without a usable
 * timestamp. The `lastCronOkMs` / `lastCronFailMs` maps plug straight into
 * {@link HealthInput}.
 */
export function summarizeCronHealth(rows: readonly CronRunRow[]): CronHealthSummary {
  const byJob = new Map<string, CronJobHealth>();

  for (const row of rows) {
    const ms = toMs(row.finished_at);
    if (ms === null) continue;
    const job = row.job;
    const current =
      byJob.get(job) ?? { job, lastRunMs: null, lastStatus: null, lastOkMs: null, lastFailMs: null };

    if (current.lastRunMs === null || ms > current.lastRunMs) {
      current.lastRunMs = ms;
      current.lastStatus = row.ok === true ? 'ok' : 'failed';
    }
    if (row.ok === true) {
      if (current.lastOkMs === null || ms > current.lastOkMs) current.lastOkMs = ms;
    } else if (current.lastFailMs === null || ms > current.lastFailMs) {
      current.lastFailMs = ms;
    }
    byJob.set(job, current);
  }

  const jobs = [...byJob.values()];
  const lastCronOkMs: Record<string, number> = {};
  const lastCronFailMs: Record<string, number> = {};
  for (const j of jobs) {
    if (j.lastOkMs !== null) lastCronOkMs[j.job] = j.lastOkMs;
    if (j.lastFailMs !== null) lastCronFailMs[j.job] = j.lastFailMs;
  }
  return { jobs, lastCronOkMs, lastCronFailMs };
}

/**
 * Best-effort heartbeat write. NEVER throws — a failed insert is swallowed (and
 * logged) so heartbeat bookkeeping can never break the cron it is monitoring.
 */
export async function recordCronRun(record: CronRunRecord): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from(CRON_RUNS_TABLE).insert(record);
    if (error) console.warn(`[cron-heartbeat] insert failed: ${error.message}`);
  } catch (err) {
    console.warn(`[cron-heartbeat] insert threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}
