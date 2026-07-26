/**
 * Cron endpoint: poll Betfair Exchange for current/projected prices on a meeting
 * day's not-yet-settled races and write `market_snapshots` + `runner_quotes`.
 *
 * Schedule: every 5 min during racing (see vercel.json). Uses the Betfair
 * Betting API (`listMarketCatalogue` + `listMarketBook`) via cert-based
 * non-interactive login; keys from env (BETFAIR_*). See `syncOddsFromBetfair`.
 *
 * DAY/DATE: defaults to today (UTC). `?day=tomorrow` targets tomorrow and
 * `?date=YYYY-MM-DD` targets a specific day (resolved by `resolveCronMeetingDate`,
 * matching the racecards convention). The resolved day is echoed back as `day`
 * and `meetingDate` in the response.
 *
 * IDEMPOTENT: snapshots are append-only time-series (the model reads the
 * latest), so each run adds at most one snapshot per matched race; a single run
 * never double-writes a race. Re-running mid-day does not corrupt state.
 *
 * MATCHING: Betfair markets/selections are matched to our races/runners on
 * (course + off-time) and normalised horse name; unmatched entities are skipped,
 * never guessed.
 *
 * AUTH: FAIL-CLOSED `CRON_SECRET` bearer (Vercel Cron sends it). An absent or
 * blank secret refuses every request; the route is never open.
 *
 * ALTERNATIVE: `/v1/racecards/standard` also bundles a "Betfair Exchange" price
 * per runner (raceSync.bundledBetfairPrice) with no cross-provider matching;
 * this route uses the live exchange directly per the pipeline spec.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { syncOddsFromBetfair } from '@/lib/liveSync';
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
  // provider and no write.
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

  // Ownership gate: after Step A auth, before any provider call or write.
  const gate = await enforceRouteOwnership(request, 'cron/odds', staticEffectiveDate(resolved.meetingDate));
  if (!gate.proceed) return gate.response;

  const startedAt = new Date();
  try {
    // `now` stays the real poll time (stamped on each snapshot); only the target
    // meeting day is overridden so ?day=tomorrow / ?date=YYYY-MM-DD work.
    const summary = await syncOddsFromBetfair(new Date(), undefined, {
      meetingDate: resolved.meetingDate,
    });
    await recordCronRun(
      buildCronRunRecord({ job: 'odds', startedAt, ok: true, httpStatus: 200, counts: { ...summary } }),
    );
    return NextResponse.json({ ok: true, day: resolved.source, ...summary });
  } catch (err) {
    const diag = buildCronErrorDiagnostic('cron/odds', err);
    console.error(formatCronErrorLog(diag));
    await recordCronRun(buildCronRunRecord({ job: 'odds', startedAt, ok: false, httpStatus: 500, error: err }));
    return NextResponse.json(
      diag.hint
        ? { ok: false, error: diag.message, hint: diag.hint }
        : { ok: false, error: diag.message },
      { status: 500 },
    );
  }
}
