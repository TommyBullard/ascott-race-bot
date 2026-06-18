/**
 * API route: GET /api/tipsters/dynamic-weights
 *
 * Returns every tracked tipster with an EXPLAINABLE dynamic decision-support
 * weight (seven-factor, sample-size-shrunk), by delegating to
 * {@link fetchDynamicTipsterWeights}. Read-only.
 *
 * DECISION-SUPPORT ONLY: this never affects model probability, EV, staking, or
 * recommendations. The reported `effective_weight` is gated by a ramp `alpha`
 * that defaults to 0 (no betting influence). Pass `?alpha=<0..1>` to PREVIEW how
 * a gradual integration would scale influence — preview only; it changes nothing.
 *
 * Response:
 * - 200 { alpha, tipsters: DynamicWeightEntry[] }
 * - 500 { error } on unexpected failure (details are logged, not exposed)
 */

import { NextResponse, type NextRequest } from 'next/server';
import { fetchDynamicTipsterWeights } from '@/lib/tipsterDynamicWeightApi';

// Always reflect the latest proofing + discovery state.
export const dynamic = 'force-dynamic';

/** Parses `?alpha=` into [0,1]; defaults to 0 (neutral / no influence). */
function parseAlpha(value: string | null): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 1);
}

export async function GET(request: NextRequest) {
  const alpha = parseAlpha(new URL(request.url).searchParams.get('alpha'));
  try {
    const tipsters = await fetchDynamicTipsterWeights({ rampAlpha: alpha });
    return NextResponse.json({ alpha, tipsters }, { status: 200 });
  } catch (error) {
    console.error('Failed to compute dynamic tipster weights:', error);
    return NextResponse.json(
      { error: 'Failed to compute dynamic tipster weights' },
      { status: 500 },
    );
  }
}
