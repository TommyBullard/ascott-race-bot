/**
 * Cron endpoint: refresh tipster signals from The Racing API.
 *
 * Runs DAILY (see `vercel.json`). It enumerates the trainers/jockeys with
 * runners on today's + tomorrow's cards, pulls their windowed performance from
 * The Racing API, maps each to a real `TipsterWindowedStats`, and feeds the
 * whole batch through the existing, tested `discoverTipsters` path — which
 * scores the needle, dedupes, and upserts `tipster_priors` + `tipsters`.
 *
 * IDEMPOTENT: discovery upserts `tipster_priors` on its (tipster_id, as_of_date)
 * primary key and resolves each entity to a stable canonical name, so running
 * twice in the same day overwrites the same rows rather than duplicating them.
 *
 * AUTH: FAIL-CLOSED. Callers MUST send `Authorization: Bearer <CRON_SECRET>`
 * (Vercel Cron does this automatically). If `CRON_SECRET` is not configured the
 * route refuses every request — it is never open, not even locally.
 *
 * SCOPE: optional query params `maxTrainers` / `maxJockeys` cap how many
 * entities are fetched (defaults are conservative to fit the serverless time
 * budget; the daily cadence accumulates coverage over time).
 */

import { NextResponse, type NextRequest } from 'next/server';

import { discoverTipsters } from '@/lib/discoverTipsters';
import { fetchRacingApiSignals } from '@/lib/racingApi';
import {
  buildCronErrorDiagnostic,
  formatCronErrorLog,
} from '@/lib/cronDiagnostics';
import { recordCronRun, buildCronRunRecord } from '@/lib/cronHeartbeat';
import { describeCronAuthFailure, requireCronSecret } from '@/lib/auth';

export const dynamic = 'force-dynamic';
// The analysis fan-out makes several throttled requests; give it headroom.
export const maxDuration = 300;

/** Default caps, kept modest so a single invocation fits the time budget. */
const DEFAULT_MAX_TRAINERS = 40;
const DEFAULT_MAX_JOCKEYS = 40;

/** Parses a positive-integer query param, falling back to a default. */
function parseCap(value: string | null, fallback: number): number {
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export async function GET(request: NextRequest) {
  // Fail-closed auth BEFORE anything else, so an unauthorized caller reaches no
  // provider and no tipster write.
  const auth = requireCronSecret(request.headers.get('authorization'), process.env.CRON_SECRET);
  if (auth !== 'authorized') {
    const refusal = describeCronAuthFailure(auth);
    if (refusal.logLine) console.error(refusal.logLine);
    return NextResponse.json(refusal.body, { status: refusal.status });
  }

  const { searchParams } = new URL(request.url);
  const maxTrainers = parseCap(searchParams.get('maxTrainers'), DEFAULT_MAX_TRAINERS);
  const maxJockeys = parseCap(searchParams.get('maxJockeys'), DEFAULT_MAX_JOCKEYS);
  const startedAt = new Date();

  try {
    const signals = await fetchRacingApiSignals({ maxTrainers, maxJockeys });
    const result = await discoverTipsters(signals);
    await recordCronRun(
      buildCronRunRecord({
        job: 'tipster-discovery', startedAt, ok: true, httpStatus: 200,
        counts: {
          received: result.received, deduped: result.deduped,
          promoted: result.promoted, demoted: result.demoted, written: result.written,
        },
      }),
    );
    return NextResponse.json({
      ok: true,
      source: 'The Racing API',
      received: result.received,
      deduped: result.deduped,
      promoted: result.promoted,
      demoted: result.demoted,
      written: result.written,
      asOfDate: result.asOfDate,
    });
  } catch (err) {
    const diag = buildCronErrorDiagnostic('cron/tipster-discovery', err);
    console.error(formatCronErrorLog(diag));
    await recordCronRun(buildCronRunRecord({ job: 'tipster-discovery', startedAt, ok: false, httpStatus: 500, error: err }));
    return NextResponse.json(
      diag.hint
        ? { ok: false, error: diag.message, hint: diag.hint }
        : { ok: false, error: diag.message },
      { status: 500 },
    );
  }
}
