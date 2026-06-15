/**
 * API route: POST /api/run-model?race_id=<id>
 *
 * Triggers a model run for the given race by delegating to
 * {@link runModelForRace}, so the model can be run over HTTP (not just via the
 * `run:model` script). This WRITES to the database (model_runs,
 * model_runner_scores, recommendations) using the service-role client.
 *
 * AUTH: because this endpoint mutates the database, it is gated behind
 * `CRON_SECRET` using the same convention as the cron routes — when the secret
 * is set, callers must send `Authorization: Bearer <CRON_SECRET>`; when it is
 * unset, the route is open for local/dev. The check is a plain equality (via
 * {@link isAuthorized}); for a personal tool this matches the existing cron
 * pattern. (A constant-time comparison would be marginally more robust against
 * timing attacks, but is intentionally omitted to stay consistent + minimal.)
 *
 * Responses:
 * - 200 RunModelResult | null  (null when the race has no priced runners /
 *       market snapshot to model)
 * - 401 { error: 'Unauthorized' } when CRON_SECRET is set and the bearer token
 *       is missing/incorrect (generic; no internal detail leaked)
 * - 400 { error } when `race_id` is missing
 * - 500 { error } on failure (the error message is included in the body)
 */

import { NextRequest, NextResponse } from 'next/server';
import { runModelForRace } from '@/lib/runModelForRace';
import { isAuthorized } from '@/lib/auth';

// Mutating, query-param driven, and data-dependent, so never cache.
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  // Gate the DB-mutating run behind CRON_SECRET (open in local/dev when unset),
  // mirroring the cron routes. Checked first so unauthorized callers learn
  // nothing about the request handling.
  if (!isAuthorized(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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
