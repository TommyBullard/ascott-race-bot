/**
 * API route: GET /api/ml/shadow-comparison
 *
 * Read-only, SHADOW-ONLY overlay for the dashboard. Returns the latest offline
 * ML shadow picks (one entry per race) for a meeting day so the UI can show the
 * candidate ML pick NEXT TO the regular model pick and the market favourite.
 *
 * STRICTLY RESEARCH / DISPLAY ONLY. It only reads a local JSON report produced
 * by `ml:predict-shadow`; it never runs the model, never touches the database,
 * and never changes any probability, EV, staking, confidence, no-bet gate, or
 * recommendation. `model_active` is always false. It is deliberately SEPARATE
 * from /api/recommendations so the production recommendation path never imports
 * or reads ML predictions. Fail-open: a missing/invalid report yields
 * `{ available: false, races: [] }`.
 *
 * Query: `?date=YYYY-MM-DD` (or `?day=`), optional `?course=Ascot`.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';

import { resolveCronMeetingDate } from '@/lib/cronDate';
import {
  buildMlShadowPicksPath,
  parseMlShadowPicksReport,
} from '@/lib/mlShadowComparison';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const resolved = resolveCronMeetingDate({
    day: searchParams.get('day'),
    date: searchParams.get('date'),
  });
  const courseParam = (searchParams.get('course') ?? '').trim();

  // Read-only local report; fail-open on any problem (missing file, bad JSON).
  try {
    const path = buildMlShadowPicksPath(resolved.meetingDate, courseParam || null);
    const report = parseMlShadowPicksReport(readFileSync(path, 'utf8'));
    if (!report) {
      return NextResponse.json(
        { available: false, model_active: false, meetingDate: resolved.meetingDate, course: courseParam || null, races: [] },
        { status: 200 },
      );
    }
    return NextResponse.json(
      {
        available: true,
        model_active: false,
        meetingDate: resolved.meetingDate,
        course: courseParam || null,
        generated_at: report.generated_at,
        model: report.model,
        disclaimer: report.disclaimer,
        races: report.races,
      },
      { status: 200 },
    );
  } catch {
    // No report present (e.g. ml:predict-shadow not run / not deployed) -> empty.
    return NextResponse.json(
      { available: false, model_active: false, meetingDate: resolved.meetingDate, course: courseParam || null, races: [] },
      { status: 200 },
    );
  }
}
