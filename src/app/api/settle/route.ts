/**
 * API route: DISABLED — `/api/settle` is permanently gone (410).
 *
 * This route used to accept `POST /api/settle?race_id=<id>&winning_runner_id=<id>`
 * and write a finishing position through the service-role client. It had NO
 * authentication of any kind, so anyone who could reach a deployment could
 * declare any runner the winner of any race — fabricating the result record
 * that accuracy, ROI, and locked-decision evaluation are all measured against.
 *
 * It is now an inert stub, deliberately following the same shape as the
 * disabled `/api/cron/recommendations` route: retained (rather than deleted) so
 * any lingering bookmark, script, or webhook receives a clear, permanent signal
 * instead of silently triggering a write.
 *
 * SETTLEMENT PATH (unchanged): results are settled by the audited, guarded
 * workflows only — `npm run import:results` (manual CSV, documented in
 * `docs/MANUAL_RESULTS_IMPORT.md`) and the authenticated `/api/cron/results`
 * job. `npm run results:auto` remains a read-only audit that never writes. No
 * replacement HTTP settlement endpoint exists or is planned.
 *
 * This file performs ZERO database access, ZERO provider calls, and imports NO
 * settlement helper. Both handlers take no request argument, so they cannot
 * read a race id, a runner id, a header, or a body. The response wording is
 * generic: it discloses no key, environment value, owner id, internal command,
 * or implementation detail.
 *
 * Decision-support only — this system never places a bet.
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** The single, generic body returned for every method. */
const GONE_BODY = {
  error:
    'This endpoint has been removed. Race results are settled only through the ' +
    'audited operator workflow; there is no HTTP settlement endpoint.',
} as const;

/** A browser navigating here gets the same inert, non-writing 410. */
export async function GET() {
  return NextResponse.json(GONE_BODY, { status: 410 });
}

export async function POST() {
  return NextResponse.json(GONE_BODY, { status: 410 });
}
