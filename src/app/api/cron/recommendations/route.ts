/**
 * Cron endpoint: DISABLED.
 *
 * This route used to recompute bet recommendations in TypeScript and upsert
 * them into `recommendations`. That is now obsolete: the recommendations
 * (and the model_runs / model_runner_scores behind them) are produced by the
 * upstream model pipeline and written to the database directly. This Next.js
 * app only READS that output (see `fetchRaceRecommendations`).
 *
 * The route is retained as an explicit, disabled stub (rather than deleted) so
 * any lingering scheduler/webhook pointing at it gets a clear signal instead of
 * silently triggering stale logic. The cron schedule has been removed from
 * `vercel.json`.
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(
    {
      error:
        'This endpoint is disabled. Recommendations are computed by the ' +
        'upstream model pipeline and read directly from the database.',
    },
    { status: 410 },
  );
}

