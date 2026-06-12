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
 * AUTH: optional `CRON_SECRET` bearer (Vercel Cron sends it). Reads
 * RACING_API_USER / RACING_API_KEY.
 *
 * NOTE: the model re-run is MARKET-ONLY — this pipeline never writes
 * `tipster_selections`.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { syncResults } from '@/lib/liveSync';

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
    const summary = await syncResults();
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
