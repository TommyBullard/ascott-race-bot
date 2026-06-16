/**
 * API route: GET /api/tipsters/status
 *
 * Returns a read-only count summary of the current tipster state for the
 * dashboard's tipster-status panel (Phase 4C-lite): approved (model-active)
 * selections plus pending / approved / rejected candidate counts, by delegating
 * to {@link fetchTipsterStatusSummary}. Counts only — it makes no model/staking
 * decision and never approves anything. Candidate counts are `null` when the
 * candidate tables are not set up yet. Read-only.
 *
 * Response:
 * - 200 { status: TipsterStatusSummary }
 * - 500 { error } on unexpected failure (details are logged, not exposed)
 */

import { NextResponse } from 'next/server';
import { fetchTipsterStatusSummary } from '@/lib/raceData';

// Always reflect the latest review/approval state.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const status = await fetchTipsterStatusSummary();
    return NextResponse.json({ status }, { status: 200 });
  } catch (error) {
    console.error('Failed to fetch tipster status:', error);
    return NextResponse.json(
      { error: 'Failed to fetch tipster status' },
      { status: 500 },
    );
  }
}
