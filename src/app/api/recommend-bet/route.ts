/**
 * API route: GET /api/recommend-bet?race_id=<id>
 *
 * Returns the top DB-computed bet recommendation for the given race by
 * delegating to {@link recommendBet}.
 *
 * Responses:
 * - 200 RaceRecommendation { race_id, runner_id, horse_name, rank, odds,
 *       model_prob, market_prob, ev, confidence_label, confidence_score,
 *       stake_pct, stake_amount }
 * - 400 { error } when `race_id` is missing
 * - 404 { error } when the race has no recommendation yet
 * - 500 { error } on unexpected failure (details are logged, not exposed)
 */

import { NextRequest, NextResponse } from 'next/server';
import { recommendBet } from '@/lib/recommendBet';

// Recommendations depend on live query params and fresh data, so never cache.
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const raceId = request.nextUrl.searchParams.get('race_id');

  if (!raceId) {
    return NextResponse.json(
      { error: 'Missing required query parameter: race_id' },
      { status: 400 },
    );
  }

  try {
    const recommendation = await recommendBet(raceId);

    if (!recommendation) {
      return NextResponse.json(
        { error: `No recommendation found for race ${raceId}` },
        { status: 404 },
      );
    }

    return NextResponse.json(recommendation, { status: 200 });
  } catch (error) {
    // Log the real cause server-side; return a generic message to the client
    // so internal details (queries, schema) are never leaked.
    console.error(`recommendBet failed for race ${raceId}:`, error);
    return NextResponse.json(
      { error: 'Failed to generate bet recommendation' },
      { status: 500 },
    );
  }
}
