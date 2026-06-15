/**
 * API route: GET /api/recommendations
 *
 * Returns one rich race card per race for a meeting day, sorted by `off_time`,
 * for the recommendations dashboard. Each card carries race meta, the market
 * favourite, the model's rank-1 pick (with stake + rationale), and 1-2
 * alternatives. Read-only.
 *
 * DAY/DATE/COURSE: defaults to today (UTC). `?day=tomorrow` or
 * `?date=YYYY-MM-DD` selects the meeting day (resolved by
 * `resolveCronMeetingDate`, matching the cron routes); optional `?course=Ascot`
 * filters to that course (normalised, so "Ascot" matches Royal Ascot). The
 * resolved selection is echoed back as `day` / `meetingDate` / `course`.
 *
 * Response:
 * - 200 { races: RaceCard[], day, meetingDate, course }
 * - 500 { error } on unexpected failure (details are logged, not exposed)
 */

import { NextResponse, type NextRequest } from 'next/server';
import {
  fetchRaceIdsForMeeting,
  fetchRaceCard,
  type RaceCard,
} from '@/lib/raceData';
import { resolveCronMeetingDate } from '@/lib/cronDate';
import { normalizeCourse } from '@/lib/raceSync';

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

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const resolved = resolveCronMeetingDate({
    day: searchParams.get('day'),
    date: searchParams.get('date'),
  });
  const courseParam = (searchParams.get('course') ?? '').trim();
  const wantCourse = courseParam === '' ? null : normalizeCourse(courseParam);

  try {
    const raceIds = await fetchRaceIdsForMeeting(resolved.meetingDate);

    // Build each race's card concurrently; isolate per-race failures so one
    // bad race cannot sink the whole dashboard.
    const settled = await Promise.allSettled(
      raceIds.map((raceId) => fetchRaceCard(raceId)),
    );

    let races: RaceCard[] = [];
    for (const result of settled) {
      if (result.status !== 'fulfilled') {
        console.error('Failed to build race card:', result.reason);
        continue;
      }
      races.push(result.value);
    }

    // Optional course filter (normalised — "Ascot" matches "Royal Ascot").
    if (wantCourse) {
      races = races.filter((c) => normalizeCourse(c.course) === wantCourse);
    }

    races.sort((a, b) => offTimeMs(a) - offTimeMs(b));

    return NextResponse.json(
      {
        races,
        day: resolved.source,
        meetingDate: resolved.meetingDate,
        course: courseParam || null,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('Failed to build recommendations list:', error);
    return NextResponse.json(
      { error: 'Failed to load recommendations' },
      { status: 500 },
    );
  }
}

