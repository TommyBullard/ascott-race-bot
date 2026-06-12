/**
 * API route: POST /api/run-model?race_id=<id>
 *
 * Triggers a model run for the given race by delegating to
 * {@link runModelForRace}, so the model can be run over HTTP (not just via the
 * `run:model` script). This WRITES to the database (model_runs,
 * model_runner_scores, recommendations) using the service-role client.
 *
 * Responses:
 * - 200 RunModelResult | null  (null when the race has no priced runners /
 *       market snapshot to model)
 * - 400 { error } when `race_id` is missing
 * - 500 { error } on failure (the error message is included in the body)
 */

import { NextRequest, NextResponse } from 'next/server';
import { runModelForRace } from '@/lib/runModelForRace';

// Mutating, query-param driven, and data-dependent, so never cache.
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
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
