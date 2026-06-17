/**
 * CLI (READ-ONLY): check whether the dashboard has enough stored data to be
 * useful for a target race day.
 *
 * It SELECT-only inspects stored DB state — races, runners, the latest odds
 * snapshot, the latest model run, recommendations, and result status (via the
 * shared read-only {@link fetchRaceCard} plus one runner-count SELECT) — then
 * reports the readiness verdict, what is missing, and SUGGESTS safe commands.
 *
 * STRICTLY READ-ONLY. It issues only `select` queries; it NEVER runs the model,
 * fetches live odds, calls an external API, imports results, mutates the
 * database, spawns a child process, or passes a commit flag. The only optional
 * write is the Markdown report file when `--report` is given. It loads
 * credentials from `.env.local` / `.env` and never prints them.
 *
 * Usage:
 *   npm run dashboard:ready -- --date 2026-06-17 --course Ascot [--report]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { normalizeCourse } from '../src/lib/raceSync';
import { fetchRaceIdsForMeeting, fetchRaceCard, type RaceCard } from '../src/lib/raceData';
import {
  parseReadinessArgs,
  assessDashboardReadiness,
  buildReadinessPath,
  renderReadinessMarkdown,
  summarizeReadiness,
  type ReadinessInput,
} from '../src/lib/dashboardReadiness';

const RUNNERS_TABLE = 'runners';

/** Loads env from `.env.local`, then `.env`; falls back to the shell env. */
function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      // Not present; try the next, then fall back to the shell env.
    }
  }
}

/** Latest non-null ISO time across the cards for a selector. */
function latestTime(cards: readonly RaceCard[], pick: (c: RaceCard) => string | null): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const card of cards) {
    const t = pick(card);
    if (!t) continue;
    const ms = Date.parse(t);
    if (!Number.isNaN(ms) && ms > bestMs) {
      bestMs = ms;
      best = t;
    }
  }
  return best;
}

/** SELECT-only count of stored runners for the given race ids (0 on failure). */
async function countRunners(raceIds: readonly string[]): Promise<number> {
  if (raceIds.length === 0) return 0;
  const { count, error } = await supabaseAdmin
    .from(RUNNERS_TABLE)
    .select('id', { count: 'exact', head: true })
    .in('race_id', raceIds as string[]);
  if (error) {
    console.error(`Note: runner-count lookup failed (${error.message}); reporting 0.`);
    return 0;
  }
  return count ?? 0;
}

async function main(): Promise<void> {
  const args = parseReadinessArgs(process.argv.slice(2));
  if (args.errors.length > 0 || !args.date) {
    console.error('dashboard:ready — READ-ONLY check of whether the dashboard has useful data for a day.\n');
    for (const error of args.errors) console.error(`  - ${error}`);
    console.error('\nUsage: npm run dashboard:ready -- --date YYYY-MM-DD [--course <name>] [--report]');
    console.error('Read-only: SELECT-only inspection, nothing executed, no database writes, no commit flag.');
    process.exitCode = 1;
    return;
  }

  loadEnv();
  const date = args.date;
  const wantCourse = args.course ? normalizeCourse(args.course) : null;

  // 1. Meeting race ids (read-only); 2. each race card (read-only); filter course.
  const cards: RaceCard[] = [];
  const raceIds: string[] = [];
  try {
    const allIds = await fetchRaceIdsForMeeting(date);
    const settled = await Promise.allSettled(allIds.map((id) => fetchRaceCard(id)));
    for (const result of settled) {
      if (result.status !== 'fulfilled') {
        console.error('Skipped a race (read failed):', result.reason);
        continue;
      }
      const card = result.value;
      if (wantCourse && normalizeCourse(card.course) !== wantCourse) continue;
      cards.push(card);
      raceIds.push(card.race_id);
    }
  } catch (err) {
    console.error(
      `Failed to read races for ${date}: ${err instanceof Error ? err.message : String(err)}\n` +
        '(check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local — read-only access).',
    );
    process.exitCode = 1;
    return;
  }

  // 3. True stored runner count (independent of any model run), read-only.
  const runnersFound = await countRunners(raceIds);

  const settledRaces = cards.filter(
    (c) =>
      (c.status ?? '').trim().toLowerCase() === 'result' ||
      (c.runners ?? []).some((r) => typeof r.finish_pos === 'number' && Number.isFinite(r.finish_pos)),
  ).length;

  const input: ReadinessInput = {
    date,
    course: args.course ?? null,
    racesFound: cards.length,
    runnersFound,
    hasOddsSnapshot: cards.some((c) => c.latestOddsSnapshotTime != null),
    latestOddsSnapshotTime: latestTime(cards, (c) => c.latestOddsSnapshotTime ?? null),
    hasModelRun: cards.some((c) => c.hasModelRun || c.latestModelRunTime != null),
    latestModelRunTime: latestTime(cards, (c) => c.latestModelRunTime ?? null),
    recommendationsCount: cards.filter((c) => c.modelPick != null).length,
    settledRaces,
    pendingRaces: cards.length - settledRaces,
  };

  const report = assessDashboardReadiness(input);
  const markdown = renderReadinessMarkdown(report);

  console.log(markdown);
  console.log(summarizeReadiness(report));

  if (args.report) {
    const outPath = buildReadinessPath(date, args.course);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, markdown, 'utf8');
    console.log(`\nReadiness report written (read-only): ${outPath}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
