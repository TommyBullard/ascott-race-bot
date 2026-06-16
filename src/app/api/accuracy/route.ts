/**
 * API route: GET /api/accuracy
 *
 * Returns:
 *  - `accuracy`: the lifetime model accuracy snapshot (strike rate, P/L, ROI
 *    across all settled races with a rank-1 pick), settled at Betfair SP.
 *  - `performance`: the Phase 5B recommendation performance for ONE meeting day
 *    (optionally a single course), computed from the STORED recommendation odds
 *    and stake — winners/losers, strike rate, P/L, ROI, average EV, plus settled
 *    vs pending counts and no-bet races. Pending races are never counted as
 *    losses.
 *
 * DAY/DATE/COURSE (for `performance` only): defaults to today (UTC).
 * `?day=tomorrow` or `?date=YYYY-MM-DD` selects the meeting day (resolved by
 * `resolveCronMeetingDate`, matching the other routes); optional `?course=Ascot`
 * filters to that course (normalised, so "Ascot" matches "Royal Ascot"). The
 * lifetime `accuracy` is global and ignores these params.
 *
 * Both are computed live on every request, so they always reflect the latest
 * settled results. Read-only.
 *
 * Response:
 * - 200 { accuracy: ModelAccuracy, performance: ModelPerformanceResult }
 * - 500 { error } on unexpected failure (details are logged, not exposed)
 */

import { NextResponse, type NextRequest } from 'next/server';
import { computeModelAccuracy, computeModelPerformance } from '@/lib/raceData';
import { resolveCronMeetingDate } from '@/lib/cronDate';

// Always reflect the latest settled results.
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const resolved = resolveCronMeetingDate({
    day: searchParams.get('day'),
    date: searchParams.get('date'),
  });
  const courseParam = (searchParams.get('course') ?? '').trim();

  try {
    const accuracy = await computeModelAccuracy();
    const performance = await computeModelPerformance({
      date: resolved.meetingDate,
      course: courseParam || null,
    });
    return NextResponse.json({ accuracy, performance }, { status: 200 });
  } catch (error) {
    console.error('Failed to compute model accuracy:', error);
    return NextResponse.json(
      { error: 'Failed to compute model accuracy' },
      { status: 500 },
    );
  }
}
