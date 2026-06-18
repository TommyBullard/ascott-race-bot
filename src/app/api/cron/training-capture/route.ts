/**
 * Cron endpoint: capture ML training examples for a meeting's SETTLED races —
 * DECOUPLED from settlement.
 *
 * WHY A DEDICATED CRON: training capture must occur whenever race OUTCOMES are
 * known (`status='result'`), not when the results API succeeds. Folding it into
 * the results cron coupled it to settlement: a `/v1/results` plan-block threw
 * before capture ran, starving the dataset (including races settled by manual CSV
 * import). This route reads ONLY DB state, so a results / Betfair / Racing API
 * outage cannot starve or poison it.
 *
 * Schedule: every 5 min, offset from the results cron (see vercel.json) so
 * settlement has written `status='result'` first. Idempotent: a watermark skips
 * already-captured races; `?recapture=1` re-captures CORRECTED results.
 *
 * AUTH: optional `CRON_SECRET` bearer. DAY/DATE via `?day=` / `?date=`.
 *
 * SHADOW / DECISION-SUPPORT ONLY: it writes the `ml_training_examples` table and
 * nothing else; it never changes probability, EV, staking, ranking, or any
 * recommendation, and the production model never reads what it writes.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { captureTrainingExamples } from '@/lib/mlCapture';
import { resolveCronMeetingDate } from '@/lib/cronDate';
import { buildCronErrorDiagnostic, formatCronErrorLog } from '@/lib/cronDiagnostics';
import { recordCronRun, buildCronRunRecord } from '@/lib/cronHeartbeat';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const startedAt = new Date();
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    if (request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const { searchParams } = new URL(request.url);
  const resolved = resolveCronMeetingDate({
    day: searchParams.get('day'),
    date: searchParams.get('date'),
  });
  const force = searchParams.get('recapture') === '1';

  try {
    const summary = await captureTrainingExamples(resolved.meetingDate, { force });
    await recordCronRun(
      buildCronRunRecord({ job: 'training-capture', startedAt, ok: true, httpStatus: 200, counts: { ...summary } }),
    );
    return NextResponse.json({ ok: true, day: resolved.source, force, ...summary });
  } catch (err) {
    const diag = buildCronErrorDiagnostic('cron/training-capture', err);
    console.error(formatCronErrorLog(diag));
    await recordCronRun(buildCronRunRecord({ job: 'training-capture', startedAt, ok: false, httpStatus: 500, error: err }));
    return NextResponse.json(
      diag.hint ? { ok: false, error: diag.message, hint: diag.hint } : { ok: false, error: diag.message },
      { status: 500 },
    );
  }
}
