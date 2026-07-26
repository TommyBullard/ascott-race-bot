/**
 * Cron endpoint: pull today's settled results from The Racing API, write
 * finish_pos + bsp_decimal + sp_decimal to the matching runners, mark each
 * matched race status='result', then re-run the model for ALL remaining
 * unsettled races today so the next-race pick refreshes.
 *
 * Schedule: every 5 min (see vercel.json). Reads `/v1/results` (Standard plan,
 * which carries Betfair SP) via `syncResults`.
 *
 * IDEMPOTENT: re-running rewrites the same result values onto the same runners
 * and re-marks the race settled — no duplication.
 *
 * MATCHING: results are matched to our races on (course + off-time) and to our
 * runners on normalised horse name; unmatched entities are skipped.
 *
 * AUTH: FAIL-CLOSED `CRON_SECRET` bearer (Vercel Cron sends it). An absent or
 * blank secret refuses every request — settlement is never open. Reads
 * RACING_API_USER / RACING_API_KEY.
 *
 * NOTE: the model re-run is MARKET-ONLY — this pipeline never writes
 * `tipster_selections`.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { syncResults } from '@/lib/liveSync';
import { resolveCronMeetingDate } from '@/lib/cronDate';
import {
  buildCronErrorDiagnostic,
  formatCronErrorLog,
} from '@/lib/cronDiagnostics';
import { recordCronRun, buildCronRunRecord } from '@/lib/cronHeartbeat';
import { describeCronAuthFailure, requireCronSecret } from '@/lib/auth';
import { enforceRouteOwnership, staticEffectiveDate } from '@/lib/routeOwnershipGuard';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  // Fail-closed auth BEFORE anything else, so an unauthorized caller reaches no
  // provider, no settlement write, and no model re-run.
  const auth = requireCronSecret(request.headers.get('authorization'), process.env.CRON_SECRET);
  if (auth !== 'authorized') {
    const refusal = describeCronAuthFailure(auth);
    if (refusal.logLine) console.error(refusal.logLine);
    return NextResponse.json(refusal.body, { status: refusal.status });
  }

  // Ownership gate: after Step A auth, before any provider call, settlement
  // write, or model re-run. syncResults is pinned to today UTC internally, so
  // the guard date uses the same today-UTC rule via resolveCronMeetingDate({}).
  const gate = await enforceRouteOwnership(
    request,
    'cron/results',
    staticEffectiveDate(resolveCronMeetingDate({}).meetingDate),
  );
  if (!gate.proceed) return gate.response;

  const startedAt = new Date();
  try {
    const summary = await syncResults();
    await recordCronRun(
      buildCronRunRecord({ job: 'results', startedAt, ok: true, httpStatus: 200, counts: { ...summary } }),
    );
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    const diag = buildCronErrorDiagnostic('cron/results', err);
    console.error(formatCronErrorLog(diag));
    await recordCronRun(buildCronRunRecord({ job: 'results', startedAt, ok: false, httpStatus: 500, error: err }));
    return NextResponse.json(
      diag.hint
        ? { ok: false, error: diag.message, hint: diag.hint }
        : { ok: false, error: diag.message },
      { status: 500 },
    );
  }
}
