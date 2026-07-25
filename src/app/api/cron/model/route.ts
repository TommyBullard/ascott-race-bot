/**
 * Cron endpoint: refresh the model for a meeting day's NOT-YET-SETTLED races so
 * the dashboard pick stays current off the latest odds — INDEPENDENTLY of result
 * settlement.
 *
 * WHY A DEDICATED MODEL CRON: the results cron also re-runs the model, but only
 * AFTER a successful result fetch. If the results feed is down (e.g. `/v1/results`
 * plan_blocked), the model would otherwise freeze. This route decouples model
 * refresh so fresh odds always produce a fresh score.
 *
 * Schedule: every 5 min during racing, offset from the odds cron (see vercel.json)
 * so it scores the snapshot the odds cron just wrote.
 *
 * MARKET-ONLY: never writes `tipster_selections`. Per-race isolated. Idempotent
 * (a re-score supersedes the prior current run; history is append-only).
 *
 * AUTH: FAIL-CLOSED `CRON_SECRET` bearer — an absent or blank secret refuses
 * every request. DAY/DATE via `?day=` / `?date=`.
 *
 * DECISION-SUPPORT ONLY: it computes + records model runs; it never places a bet.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { refreshModelForMeeting } from '@/lib/liveSync';
import { resolveCronMeetingDate } from '@/lib/cronDate';
import { buildCronErrorDiagnostic, formatCronErrorLog } from '@/lib/cronDiagnostics';
import { recordCronRun, buildCronRunRecord } from '@/lib/cronHeartbeat';
import { describeCronAuthFailure, requireCronSecret } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const startedAt = new Date();
  // Fail-closed auth BEFORE anything else, so an unauthorized caller reaches no
  // model persistence.
  const auth = requireCronSecret(request.headers.get('authorization'), process.env.CRON_SECRET);
  if (auth !== 'authorized') {
    const refusal = describeCronAuthFailure(auth);
    if (refusal.logLine) console.error(refusal.logLine);
    return NextResponse.json(refusal.body, { status: refusal.status });
  }

  const { searchParams } = new URL(request.url);
  const resolved = resolveCronMeetingDate({
    day: searchParams.get('day'),
    date: searchParams.get('date'),
  });

  try {
    const summary = await refreshModelForMeeting(resolved.meetingDate);
    await recordCronRun(
      buildCronRunRecord({ job: 'model', startedAt, ok: true, httpStatus: 200, counts: { ...summary } }),
    );
    return NextResponse.json({ ok: true, day: resolved.source, ...summary });
  } catch (err) {
    const diag = buildCronErrorDiagnostic('cron/model', err);
    console.error(formatCronErrorLog(diag));
    await recordCronRun(buildCronRunRecord({ job: 'model', startedAt, ok: false, httpStatus: 500, error: err }));
    return NextResponse.json(
      diag.hint ? { ok: false, error: diag.message, hint: diag.hint } : { ok: false, error: diag.message },
      { status: 500 },
    );
  }
}
