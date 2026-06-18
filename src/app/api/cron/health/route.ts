/**
 * Read-only health endpoint: GET /api/cron/health
 *
 * Consolidated freshness + monitoring for the self-updating race-day system.
 * Gathers SELECT-only signals for a meeting day (its races, the latest odds
 * snapshot, the latest model run, and the recent cron heartbeats) and returns the
 * per-stage health, overall system status, and the operator's next action — the
 * data behind the dashboard freshness indicators and any external uptime monitor.
 *
 * It RUNS NOTHING and WRITES NOTHING: pure read + the pure {@link assessRaceDayHealth}.
 * Decision-support only; it never places a bet.
 *
 * DAY/DATE via `?day=` / `?date=`. AUTH: optional `CRON_SECRET` bearer.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { resolveCronMeetingDate } from '@/lib/cronDate';
import { assessRaceDayHealth, type HealthRace } from '@/lib/raceDayHealth';
import { summarizeCronHealth, type CronRunRow } from '@/lib/cronHeartbeat';

export const dynamic = 'force-dynamic';

/** ISO timestamp → epoch ms, or null. */
function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const resolved = resolveCronMeetingDate({ day: searchParams.get('day'), date: searchParams.get('date') });
  const now = new Date();

  try {
    // 1. The meeting's races (off time + status).
    const { data: raceData, error: raceErr } = await supabaseAdmin
      .from('races')
      .select('id, off_time, status')
      .eq('meeting_date', resolved.meetingDate);
    if (raceErr) throw new Error(`races lookup failed: ${raceErr.message}`);
    const raceRows = (raceData ?? []) as { id: string; off_time: string | null; status: string | null }[];
    const races: HealthRace[] = raceRows.map((r) => ({ offTimeMs: toMs(r.off_time), status: r.status }));
    const raceIds = raceRows.map((r) => r.id);

    // 2. Latest odds snapshot + latest model run across the meeting (newest-first).
    let latestOddsMs: number | null = null;
    let latestModelMs: number | null = null;
    if (raceIds.length > 0) {
      const [oddsRes, modelRes] = await Promise.all([
        supabaseAdmin
          .from('market_snapshots')
          .select('snapshot_time')
          .in('race_id', raceIds)
          .order('snapshot_time', { ascending: false })
          .limit(1),
        supabaseAdmin
          .from('model_runs')
          .select('run_time')
          .in('race_id', raceIds)
          .order('run_time', { ascending: false })
          .limit(1),
      ]);
      latestOddsMs = toMs(((oddsRes.data ?? [])[0] as { snapshot_time?: string } | undefined)?.snapshot_time ?? null);
      latestModelMs = toMs(((modelRes.data ?? [])[0] as { run_time?: string } | undefined)?.run_time ?? null);
    }

    // 3. Recent cron heartbeats (last 2h), reduced to per-job last OK/FAIL.
    const since = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const { data: cronData } = await supabaseAdmin
      .from('cron_runs')
      .select('job, finished_at, ok')
      .gte('finished_at', since)
      .order('finished_at', { ascending: false });
    const heartbeat = summarizeCronHealth((cronData ?? []) as CronRunRow[]);

    const health = assessRaceDayHealth({
      now,
      races,
      latestOddsMs,
      latestModelMs,
      lastCronOkMs: heartbeat.lastCronOkMs,
      lastCronFailMs: heartbeat.lastCronFailMs,
    });

    return NextResponse.json({
      meetingDate: resolved.meetingDate,
      day: resolved.source,
      generatedAt: now.toISOString(),
      health,
      cronJobs: heartbeat.jobs,
    });
  } catch (err) {
    console.error('[cron/health] failed:', err);
    return NextResponse.json({ error: 'Failed to compute race-day health' }, { status: 500 });
  }
}
