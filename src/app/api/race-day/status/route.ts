/**
 * API route: GET /api/race-day/status?date=YYYY-MM-DD&course=COURSE
 *
 * A consolidated, READ-ONLY race-day status snapshot for dashboard polling. It
 * joins (all read-only / stored-state only):
 *   - the (pre-off) recommendation performance via `computeModelPerformance`,
 *   - each race's card via the shared `fetchRaceCard` (which already applies the
 *     pre-off run selection, so post-off reruns never supersede the decision),
 * and assembles them with the pure {@link buildRaceDayStatus} builder into a
 * compact JSON object: performance summary, next race, per-race state +
 * freshness + result, the operator next action, and explicit safety flags
 * (`readOnly: true`, `autoBetting: false`, `uiCommitAllowed: false`).
 *
 * STRICTLY READ-ONLY. It issues only `select` queries (through the shared
 * helpers); it NEVER runs the model, fetches live odds, calls an external API,
 * imports results, mutates the database, or exposes a commit / write control.
 *
 * Response:
 * - 400 { error } when the date is missing / not a valid YYYY-MM-DD.
 * - 200 RaceDayStatusResponse.
 * - 500 { error } on unexpected failure (details logged, not exposed).
 */

import { NextResponse, type NextRequest } from 'next/server';

import {
  computeModelPerformance,
  fetchRaceIdsForMeeting,
  fetchRaceCard,
} from '@/lib/raceData';
import { normalizeCourse } from '@/lib/raceSync';
import {
  buildRaceDayStatus,
  isValidIsoDate,
  type StatusCardInput,
} from '@/lib/raceDayStatusApi';

// Always reflect the latest stored state.
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const date = (searchParams.get('date') ?? '').trim();
  const courseParam = (searchParams.get('course') ?? '').trim();

  if (!isValidIsoDate(date)) {
    return NextResponse.json(
      { error: 'Invalid or missing date — expected YYYY-MM-DD.' },
      { status: 400 },
    );
  }

  const wantCourse = courseParam ? normalizeCourse(courseParam) : null;

  try {
    // Performance (pre-off) + the meeting's race ids, read-only.
    const [performance, raceIds] = await Promise.all([
      computeModelPerformance({ date, course: courseParam || null }),
      fetchRaceIdsForMeeting(date),
    ]);

    // Build each race card concurrently; isolate per-race read failures.
    const settled = await Promise.allSettled(raceIds.map((id) => fetchRaceCard(id)));
    const cards: StatusCardInput[] = [];
    for (const result of settled) {
      if (result.status !== 'fulfilled') {
        console.error('race-day/status: failed to build a race card:', result.reason);
        continue;
      }
      const card = result.value;
      if (wantCourse && normalizeCourse(card.course) !== wantCourse) continue;
      cards.push({
        race_id: card.race_id,
        off_time: card.off_time,
        race_name: card.race_name,
        course: card.course,
        status: card.status ?? null,
        result_time: card.result_time ?? null,
        oddsUpdatedAt: card.latestOddsSnapshotTime ?? null,
        modelUpdatedAt: card.latestModelRunTime ?? null,
        hasModelRun: card.hasModelRun,
        runQuality: card.observability?.runQuality ?? null,
        confidenceLabel: card.modelPick?.confidence_label ?? null,
        modelPick: card.modelPick
          ? {
              runner_id: card.modelPick.runner_id,
              horse_name: card.modelPick.horse_name,
              odds: card.modelPick.odds,
              finish_pos: card.modelPick.finish_pos ?? null,
            }
          : null,
        favourite: card.favourite
          ? {
              runner_id: card.favourite.runner_id,
              horse_name: card.favourite.horse_name,
              odds: card.favourite.odds,
              finish_pos: card.favourite.finish_pos ?? null,
            }
          : null,
      });
    }

    const status = buildRaceDayStatus({
      date,
      course: courseParam || null,
      now: Date.now(),
      cards,
      performance,
    });

    return NextResponse.json(status, { status: 200 });
  } catch (error) {
    console.error('Failed to build race-day status:', error);
    return NextResponse.json(
      { error: 'Failed to build race-day status' },
      { status: 500 },
    );
  }
}
