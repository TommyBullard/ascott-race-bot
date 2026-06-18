/**
 * Read-only ML reporting endpoint: GET /api/ml/calibration
 *
 * Serves the shadow learning pipeline's dashboard data from the captured
 * `ml_training_examples`: MODEL calibration (model_prob vs realised win rate),
 * CONFIDENCE calibration (by band), explainable FEATURE IMPORTANCE, and the
 * headline outcome summary (recommendation / favourite hit rates).
 *
 * STRICTLY SHADOW / DECISION-SUPPORT: it READS the capture table and computes
 * metrics; it never trains, never changes the production model, and never places
 * a bet. Window via `?from=YYYY-MM-DD&to=YYYY-MM-DD` (default: last 30 days).
 * AUTH: optional `CRON_SECRET` bearer.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { calibrateBinary, calibrateConfidence, type CalibrationSample, type ConfidenceSample } from '@/lib/mlCalibration';
import { rankFeatureImportance, type FeatureExtractor } from '@/lib/featureImportance';

export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** One captured example row (the subset this report reads). */
interface ExampleRow {
  model_prob: number | null;
  market_prob: number | null;
  edge: number | null;
  ev: number | null;
  odds: number | null;
  confidence_score: number | null;
  is_favourite: boolean | null;
  recommended: boolean | null;
  field_size: number | null;
  won: boolean | null;
  placed: boolean | null;
  favourite_won: boolean | null;
}

/** YYYY-MM-DD (UTC) for a date offset by `days`. */
function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function num01(v: boolean | null): 0 | 1 {
  return v === true ? 1 : 0;
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const fromParam = (searchParams.get('from') ?? '').trim();
  const toParam = (searchParams.get('to') ?? '').trim();
  const from = DATE_RE.test(fromParam) ? fromParam : isoDay(-30);
  const to = DATE_RE.test(toParam) ? toParam : isoDay(0);

  try {
    const { data, error } = await supabaseAdmin
      .from('ml_training_examples')
      .select(
        'model_prob, market_prob, edge, ev, odds, confidence_score, is_favourite, recommended, field_size, won, placed, favourite_won',
      )
      .gte('meeting_date', from)
      .lte('meeting_date', to)
      .not('won', 'is', null);
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as ExampleRow[];

    // Model calibration: model_prob -> won.
    const modelSamples: CalibrationSample[] = rows
      .filter((r) => typeof r.model_prob === 'number')
      .map((r) => ({ prob: r.model_prob as number, outcome: num01(r.won) }));
    const modelCalibration = calibrateBinary(modelSamples);

    // Confidence calibration: confidence_score -> won, by band.
    const confSamples: ConfidenceSample[] = rows
      .filter((r) => typeof r.confidence_score === 'number')
      .map((r) => ({ score: r.confidence_score as number, outcome: num01(r.won) }));
    const confidenceCalibration = calibrateConfidence(confSamples);

    // Feature importance vs `won` (model-free association; research aid only).
    const features: FeatureExtractor<ExampleRow>[] = [
      { feature: 'model_prob', extract: (r) => r.model_prob },
      { feature: 'market_prob', extract: (r) => r.market_prob },
      { feature: 'edge', extract: (r) => r.edge },
      { feature: 'ev', extract: (r) => r.ev },
      { feature: 'odds', extract: (r) => r.odds },
      { feature: 'confidence_score', extract: (r) => r.confidence_score },
      { feature: 'is_favourite', extract: (r) => num01(r.is_favourite ?? null) },
      { feature: 'field_size', extract: (r) => r.field_size },
    ];
    const featureImportance = rankFeatureImportance(rows, features, (r) => num01(r.won));

    // Headline outcome summary.
    const recommended = rows.filter((r) => r.recommended === true);
    const recommendedWon = recommended.filter((r) => r.won === true).length;
    const favourites = rows.filter((r) => r.is_favourite === true);
    const favouritesWon = favourites.filter((r) => r.won === true).length;

    return NextResponse.json({
      window: { from, to },
      sampleSize: rows.length,
      summary: {
        recommendations: recommended.length,
        recommendationWinRate: recommended.length > 0 ? recommendedWon / recommended.length : null,
        favourites: favourites.length,
        favouriteWinRate: favourites.length > 0 ? favouritesWon / favourites.length : null,
      },
      modelCalibration,
      confidenceCalibration,
      featureImportance,
    });
  } catch (err) {
    console.error('[ml/calibration] failed:', err);
    return NextResponse.json({ error: 'Failed to compute ML calibration report' }, { status: 500 });
  }
}
