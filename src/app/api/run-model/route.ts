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
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { describeCronAuthFailure, requireCronSecret } from '@/lib/auth';
import { enforceRouteOwnership, type EffectiveDate } from '@/lib/routeOwnershipGuard';

// Mutating, query-param driven, and data-dependent, so never cache.
export const dynamic = 'force-dynamic';

/**
 * Read-only resolution of a race's meeting date, used ONLY by the ownership
 * guard and ONLY when a valid context was supplied. It is a single SELECT, no
 * write, and its result is never returned to the caller. A missing race id, a
 * lookup error, or an absent meeting_date all resolve to `{ ok: false }` so the
 * guard fails closed (503) rather than run the model on an unverifiable date.
 */
function resolveRaceMeetingDate(raceId: string | null): () => Promise<EffectiveDate> {
  return async () => {
    if (!raceId) return { ok: false };
    const { data, error } = await supabaseAdmin
      .from('races')
      .select('meeting_date')
      .eq('id', raceId)
      .limit(1)
      .maybeSingle();
    if (error || !data) return { ok: false };
    const meetingDate = (data as { meeting_date?: string | null }).meeting_date;
    if (!meetingDate) return { ok: false };
    return { ok: true, date: String(meetingDate).slice(0, 10) };
  };
}

export async function POST(request: NextRequest) {
  // Step A FIRST: fail-closed CRON_SECRET. An unauthorized caller reaches no
  // ownership query, no race lookup, and no model execution.
  const auth = requireCronSecret(request.headers.get('authorization'), process.env.CRON_SECRET);
  if (auth !== 'authorized') {
    const refusal = describeCronAuthFailure(auth);
    if (refusal.logLine) console.error(refusal.logLine);
    return NextResponse.json(refusal.body, { status: refusal.status });
  }

  const raceId = new URL(request.url).searchParams.get('race_id');

  // Ownership gate: the race->meeting_date lookup runs LAZILY inside the guard,
  // only when a valid context was supplied (absent/off skip it entirely), and
  // always before any model execution.
  const gate = await enforceRouteOwnership(request, 'api/run-model', resolveRaceMeetingDate(raceId));
  if (!gate.proceed) return gate.response;

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
