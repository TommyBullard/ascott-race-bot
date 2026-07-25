/**
 * API route: POST /api/run-model?race_id=<id>
 *
 * Triggers a model run for the given race by delegating to
 * {@link runModelForRace}, so the model can be run over HTTP (not just via the
 * `run:model` script). This WRITES to the database (model_runs,
 * model_runner_scores, recommendations) using the service-role client.
 *
 * AUTH: FAIL-CLOSED. Because this endpoint mutates the database it requires
 * `Authorization: Bearer <CRON_SECRET>` on every call, and it REFUSES every
 * request when `CRON_SECRET` is not configured — it is never open, not even
 * locally (see {@link requireCronSecret}). The comparison is a plain exact
 * equality; a constant-time comparison would be marginally more robust against
 * timing attacks but is intentionally omitted to stay consistent + minimal.
 *
 * Responses:
 * - 200 RunModelResult | null  (null when the race has no priced runners /
 *       market snapshot to model)
 * - 401 { error: 'Unauthorized' } when the bearer token is missing/incorrect
 *       (generic; no internal detail leaked)
 * - 503 { error: 'Endpoint unavailable' } when CRON_SECRET is not configured
 * - 400 { error } when `race_id` is missing
 * - 500 { error } on failure (the error message is included in the body)
 */

import { NextRequest, NextResponse } from 'next/server';
import { runModelForRace } from '@/lib/runModelForRace';
import { describeCronAuthFailure, requireCronSecret } from '@/lib/auth';

// Mutating, query-param driven, and data-dependent, so never cache.
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  // Gate the DB-mutating run behind a FAIL-CLOSED CRON_SECRET check, mirroring
  // the cron routes. Checked first so an unauthorized caller reaches no model
  // execution and learns nothing about the request handling.
  const auth = requireCronSecret(request.headers.get('authorization'), process.env.CRON_SECRET);
  if (auth !== 'authorized') {
    const refusal = describeCronAuthFailure(auth);
    if (refusal.logLine) console.error(refusal.logLine);
    return NextResponse.json(refusal.body, { status: refusal.status });
  }

  const raceId = request.nextUrl.searchParams.get('race_id');

  if (!raceId) {
    return NextResponse.json(
      { error: 'Missing required query parameter: race_id' },
      { status: 400 },
    );
  }

  try {
    const result = await runModelForRace(raceId);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`runModelForRace failed for race ${raceId}:`, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
