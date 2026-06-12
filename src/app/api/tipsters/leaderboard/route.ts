/**
 * API route: GET /api/tipsters/leaderboard
 *
 * Returns every tracked tipster (one with at least one `tipster_priors` row),
 * active and demoted, with their latest proofed metrics, by delegating to
 * {@link fetchTipsterLeaderboard}. Read-only.
 *
 * Response:
 * - 200 { tipsters: TipsterLeaderboardEntry[] }
 * - 500 { error } on unexpected failure (details are logged, not exposed)
 */

import { NextResponse } from 'next/server';
import { fetchTipsterLeaderboard } from '@/lib/raceData';

// Always reflect the latest discovery + promotion state.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const tipsters = await fetchTipsterLeaderboard();
    return NextResponse.json({ tipsters }, { status: 200 });
  } catch (error) {
    console.error('Failed to fetch tipster leaderboard:', error);
    return NextResponse.json(
      { error: 'Failed to fetch tipster leaderboard' },
      { status: 500 },
    );
  }
}
