/**
 * API route: GET /api/recommendations
 *
 * Returns one rich race card per today's race, sorted by `off_time`, for the
 * recommendations dashboard. Each card carries race meta, the market favourite,
 * the model's rank-1 pick (with stake + rationale), and 1-2 alternatives.
 * Read-only.
 *
 * Response:
 * - 200 { races: RaceCard[] }
 * - 500 { error } on unexpected failure (details are logged, not exposed)
 */

import { NextResponse } from 'next/server';
import {
  fetchTodaysRaceIds,
  fetchRaceCard,
  type RaceCard,
} from '@/lib/raceData';

// Always reflect the latest model output.
export const dynamic = 'force-dynamic';

/** Sort key for off_time: known times first (ascending), unknowns last. */
function offTimeMs(card: RaceCard): number {
  if (!card.off_time) {
    return Number.POSITIVE_INFINITY;
  }
  const ms = Date.parse(card.off_time);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

export async function GET() {
  try {
    const raceIds = await fetchTodaysRaceIds();

    // Build each race's card concurrently; isolate per-race failures so one
    // bad race cannot sink the whole dashboard.
    const settled = await Promise.allSettled(
      raceIds.map((raceId) => fetchRaceCard(raceId)),
    );

    const races: RaceCard[] = [];
    for (const result of settled) {
      if (result.status !== 'fulfilled') {
        console.error('Failed to build race card:', result.reason);
        continue;
      }
      races.push(result.value);
    }

    races.sort((a, b) => offTimeMs(a) - offTimeMs(b));

    return NextResponse.json({ races }, { status: 200 });
  } catch (error) {
    console.error('Failed to build recommendations list:', error);
    return NextResponse.json(
      { error: 'Failed to load recommendations' },
      { status: 500 },
    );
  }
}

