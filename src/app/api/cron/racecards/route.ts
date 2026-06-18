/**
 * Cron endpoint: pull today's UK & Irish racecards from The Racing API and
 * upsert `races` (status='scheduled') + their `runners`.
 *
 * Schedule: DAILY ~07:00 (see vercel.json). Reads `/v1/racecards/standard`
 * (Standard plan) and writes via `syncRacecards`.
 *
 * IDEMPOTENT: a race already present (matched on course + off_time) is reused
 * and never downgraded; only runners missing by name are inserted. Running
 * twice in a day does not duplicate.
 *
 * AUTH: if `CRON_SECRET` is set, callers must send `Authorization: Bearer
 * <CRON_SECRET>` (Vercel Cron does this). Reads RACING_API_USER / RACING_API_KEY.
 *
 * NOTE: this pipeline does NOT populate `tipster_selections`; the model runs
 * market-only until tips are supplied separately.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { syncRacecards } from '@/lib/liveSync';
import {
  buildCronErrorDiagnostic,
  formatCronErrorLog,
} from '@/lib/cronDiagnostics';
import { recordCronRun, buildCronRunRecord } from '@/lib/cronHeartbeat';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    if (request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const day = new URL(request.url).searchParams.get('day');
  const dayParam = day === 'tomorrow' ? 'tomorrow' : 'today';
  const startedAt = new Date();

  try {
    const summary = await syncRacecards({ day: dayParam });
    await recordCronRun(
      buildCronRunRecord({ job: 'racecards', startedAt, ok: true, httpStatus: 200, counts: { ...summary } }),
    );
    return NextResponse.json({ ok: true, day: dayParam, ...summary });
  } catch (err) {
    const diag = buildCronErrorDiagnostic('cron/racecards', err);
    console.error(formatCronErrorLog(diag));
    await recordCronRun(buildCronRunRecord({ job: 'racecards', startedAt, ok: false, httpStatus: 500, error: err }));
    return NextResponse.json(
      diag.hint
        ? { ok: false, error: diag.message, hint: diag.hint }
        : { ok: false, error: diag.message },
      { status: 500 },
    );
  }
}
