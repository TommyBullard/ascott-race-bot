/**
 * API route: GET /api/accuracy
 *
 * Returns the live model accuracy snapshot (strike rate, P/L, ROI across all
 * settled races with a rank-1 pick) by delegating to {@link computeModelAccuracy}.
 * Computed on every request, so it always reflects the latest settled results.
 * Read-only.
 *
 * Response:
 * - 200 { accuracy: ModelAccuracy }
 * - 500 { error } on unexpected failure (details are logged, not exposed)
 */

import { NextResponse } from 'next/server';
import { computeModelAccuracy } from '@/lib/raceData';

// Always reflect the latest settled results.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const accuracy = await computeModelAccuracy();
    return NextResponse.json({ accuracy }, { status: 200 });
  } catch (error) {
    console.error('Failed to compute model accuracy:', error);
    return NextResponse.json(
      { error: 'Failed to compute model accuracy' },
      { status: 500 },
    );
  }
}
