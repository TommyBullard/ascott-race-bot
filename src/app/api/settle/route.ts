/**
 * API route: POST /api/settle?race_id=<id>&winning_runner_id=<id>
 *
 * Records a race result (marks the winning runner `finish_pos = 1`) via
 * {@link settleRace}, then recomputes and returns the live model accuracy, so
 * the tracker updates as results come in. WRITES to the database (runners)
 * using the service-role client.
 *
 * Responses:
 * - 200 { settled: SettleResult, accuracy: ModelAccuracy }
 * - 400 { error } when a query param is missing, or the runner is not in the race
 * - 500 { error } on unexpected failure
 */

import { NextRequest, NextResponse } from 'next/server';
import { settleRace, computeModelAccuracy } from '@/lib/raceData';

// Mutating and data-dependent, so never cache.
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const raceId = request.nextUrl.searchParams.get('race_id');
  const winningRunnerId = request.nextUrl.searchParams.get('winning_runner_id');

  if (!raceId || !winningRunnerId) {
    return NextResponse.json(
      {
        error:
          'Missing required query parameters: race_id and winning_runner_id',
      },
      { status: 400 },
    );
  }

  try {
    const settled = await settleRace(raceId, winningRunnerId);
    // Recompute live so the response (and the next dashboard poll) reflects it.
    const accuracy = await computeModelAccuracy();
    return NextResponse.json({ settled, accuracy }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`settleRace failed for race ${raceId}:`, error);
    // A "not in race" error is a bad-input (client) error, not a server fault.
    const status = message.includes('is not in race') ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
