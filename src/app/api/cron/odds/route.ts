/**
 * Cron endpoint: poll Betfair Exchange for current/projected prices on today's
 * not-yet-settled races and write `market_snapshots` + `runner_quotes`.
 *
 * Schedule: every 5 min during racing (see vercel.json). Uses the Betfair
 * Betting API (`listMarketCatalogue` + `listMarketBook`) via cert-based
 * non-interactive login; keys from env (BETFAIR_*). See `syncOddsFromBetfair`.
 *
 * IDEMPOTENT: snapshots are append-only time-series (the model reads the
 * latest), so each run adds at most one snapshot per matched race; a single run
 * never double-writes a race. Re-running mid-day does not corrupt state.
 *
 * MATCHING: Betfair markets/selections are matched to our races/runners on
 * (course + off-time) and normalised horse name; unmatched entities are skipped,
 * never guessed.
 *
 * AUTH: optional `CRON_SECRET` bearer (Vercel Cron sends it).
 *
 * ALTERNATIVE: `/v1/racecards/standard` also bundles a "Betfair Exchange" price
 * per runner (raceSync.bundledBetfairPrice) with no cross-provider matching;
 * this route uses the live exchange directly per the pipeline spec.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { syncOddsFromBetfair } from '@/lib/liveSync';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    if (request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const summary = await syncOddsFromBetfair();
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
