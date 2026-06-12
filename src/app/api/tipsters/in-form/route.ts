/**
 * API route: GET /api/tipsters/in-form?limit=<n>
 *
 * Returns the top in-form (active) tipsters by needle weight, with their
 * latest proofed ROI, 30d ROI, streak, and any picks for today's races, by
 * delegating to {@link fetchInFormTipsters}. Read-only.
 *
 * Response:
 * - 200 { tipsters: InFormTipster[] }
 * - 500 { error } on unexpected failure (details are logged, not exposed)
 */

import { NextRequest, NextResponse } from 'next/server';
import { fetchInFormTipsters } from '@/lib/discoverTipsters';

// Always reflect the latest discovery + settlement state.
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get('limit');
  let limit = DEFAULT_LIMIT;
  if (raw !== null) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      limit = Math.min(Math.floor(parsed), MAX_LIMIT);
    }
  }

  try {
    const tipsters = await fetchInFormTipsters(limit);
    return NextResponse.json({ tipsters }, { status: 200 });
  } catch (error) {
    console.error('Failed to fetch in-form tipsters:', error);
    return NextResponse.json(
      { error: 'Failed to fetch in-form tipsters' },
      { status: 500 },
    );
  }
}
