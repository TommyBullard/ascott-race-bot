/**
 * CLI (READ-ONLY): durable race-day "proof of update" report.
 *
 * Consolidates SELECT-only stored state (races, runners, latest odds snapshot,
 * model runs, recommendations, result status) plus BEST-EFFORT reads of the audit
 * tables (`cron_runs`, `ml_training_examples`, `genai_commentary`) and a
 * filesystem check for a generated commentary file, into a single durable proof
 * of WHEN each stage last refreshed.
 *
 * STRICTLY READ-ONLY. It issues only `select` reads; it NEVER writes the database,
 * runs the model, fetches live odds, places a bet, or passes a commit flag. When
 * an audit table is missing it degrades gracefully and names the migration. The
 * only write is the local Markdown report. Credentials are loaded from
 * `.env.local` / `.env` and never printed.
 *
 * Usage:
 *   npm run proof:day -- --date YYYY-MM-DD --course COURSE
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { normalizeCourse } from '../src/lib/raceSync';
import { fetchRaceIdsForMeeting, fetchRaceCard, type RaceCard } from '../src/lib/raceData';
import { classifyTableProbe } from '../src/lib/dbHealthSpec';
import {
  parseProofArgs,
  buildProofPath,
  buildCommentaryPath,
  summarizeProofCron,
  renderProofMarkdown,
  summarizeProof,
  type DayProofInput,
  type ProofRaceInput,
  type ProofCronRow,
  type ProofCronJob,
} from '../src/lib/proofDay';

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

function isFiniteNum(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** Keeps only finite numeric entries from a jsonb counts bag. */
function numericCounts(counts: unknown): Record<string, number> | null {
  if (!counts || typeof counts !== 'object') return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** One stored runner row (finish source), coerced for the winner lookup. */
interface StoredRunnerRow {
  runner_id: string;
  horse_name: string;
  finish_pos: number | null;
}

/**
 * SELECT-only read of ALL stored runners (name + finish_pos) for the given
 * races. The winner must come from the FULL stored field, not the model run's
 * scored subset (`card.runners`): a winner the model never scored — e.g. an
 * unpriced runner — is otherwise invisible and renders as "—" even though
 * `runners.finish_pos = 1` exists (Newmarket 2026-07-09, Princess Of Wales's
 * Stakes). Mirrors reportDay's direct read. Returns null on failure so the
 * caller can fall back to the scored-field logic instead of breaking.
 */
async function readStoredRunners(
  ids: readonly string[],
): Promise<Map<string, StoredRunnerRow[]> | null> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabaseAdmin
    .from('runners')
    .select('id, race_id, horse_name, finish_pos')
    .in('race_id', ids as string[]);
  if (error || !data) {
    console.error(
      `Note: runners finish-pos read failed (${error?.message ?? 'no data'}); ` +
        'winners will fall back to the scored field only.',
    );
    return null;
  }
  const map = new Map<string, StoredRunnerRow[]>();
  for (const raw of data as {
    id: string | number;
    race_id: string | number;
    horse_name: string | null;
    finish_pos: number | string | null;
  }[]) {
    const raceId = String(raw.race_id);
    const rows = map.get(raceId) ?? [];
    const n = raw.finish_pos === null || raw.finish_pos === undefined ? null : Number(raw.finish_pos);
    rows.push({
      runner_id: String(raw.id),
      horse_name: raw.horse_name ?? '(unknown)',
      finish_pos: Number.isFinite(n as number) ? (n as number) : null,
    });
    map.set(raceId, rows);
  }
  return map;
}

/** SELECT-only count of stored runners for the given race ids (null on failure). */
async function countRunners(ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { count, error } = await supabaseAdmin
    .from('runners')
    .select('id', { count: 'exact', head: true })
    .in('race_id', ids as string[]);
  if (error) {
    console.error(`Note: runner-count lookup failed (${error.message}); reporting 0.`);
    return 0;
  }
  return count ?? 0;
}

/** Per-race model-run totals + post-off counts (read-only; null map on failure). */
async function readModelRuns(
  ids: readonly string[],
  offByRace: Map<string, string | null>,
): Promise<Map<string, { total: number; postOff: number }> | null> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabaseAdmin
    .from('model_runs')
    .select('race_id, run_time')
    .in('race_id', ids as string[]);
  if (error || !data) {
    console.error(`Note: model_runs read failed (${error?.message ?? 'no data'}); run counts unavailable.`);
    return null;
  }
  const map = new Map<string, { total: number; postOff: number }>();
  for (const row of data as { race_id: string; run_time: string | null }[]) {
    const cur = map.get(row.race_id) ?? { total: 0, postOff: 0 };
    cur.total += 1;
    const off = offByRace.get(row.race_id) ?? null;
    const offMs = off ? Date.parse(off) : NaN;
    const runMs = row.run_time ? Date.parse(row.run_time) : NaN;
    if (!Number.isNaN(offMs) && !Number.isNaN(runMs) && runMs > offMs) cur.postOff += 1;
    map.set(row.race_id, cur);
  }
  return map;
}

/** Best-effort cron_runs read; available=false when the table is missing. */
async function readCron(): Promise<{ available: boolean; jobs: ProofCronJob[] }> {
  const { data, error } = await supabaseAdmin
    .from('cron_runs')
    .select('job, finished_at, ok, counts')
    .order('finished_at', { ascending: false })
    .limit(300);
  if (error) {
    if (classifyTableProbe(error) === 'present') {
      console.error(`Note: cron_runs read failed (${error.message}).`);
    }
    return { available: false, jobs: [] };
  }
  const rows: ProofCronRow[] = (data ?? []).map((r) => {
    const row = r as { job: string; finished_at: string | null; ok: boolean | null; counts: unknown };
    return { job: row.job, finished_at: row.finished_at, ok: row.ok, counts: numericCounts(row.counts) };
  });
  return { available: true, jobs: summarizeProofCron(rows) };
}

/** Best-effort row count for an audit table; available=false when missing. */
async function countAuditTable(
  table: string,
  ids: readonly string[],
): Promise<{ available: boolean; value: number | null }> {
  const { count, error } = await supabaseAdmin
    .from(table)
    .select('id', { count: 'exact', head: true })
    .in('race_id', ids as string[]);
  if (error) {
    if (classifyTableProbe(error) === 'present') {
      console.error(`Note: ${table} count failed (${error.message}).`);
      return { available: true, value: null };
    }
    return { available: false, value: null };
  }
  return { available: true, value: count ?? 0 };
}

function toRaceInput(
  card: RaceCard,
  runs: { total: number; postOff: number } | null,
  runsQueried: boolean,
  stored: StoredRunnerRow[] | null,
): ProofRaceInput {
  // Winner + finish availability come from the FULL stored field when readable
  // (the scored field can miss the winner); scored-field values are the
  // fallback. "—" still means exactly "no finish_pos = 1 recorded anywhere".
  const finishPosAvailable =
    (stored?.some((r) => isFiniteNum(r.finish_pos)) ?? false) ||
    card.runners.some((r) => isFiniteNum(r.finish_pos));
  const winner =
    stored?.find((r) => r.finish_pos === 1) ??
    card.runners.find((r) => r.finish_pos === 1) ??
    null;
  return {
    raceId: card.race_id,
    offTime: card.off_time,
    raceName: card.race_name,
    fieldSize: card.runners.length,
    latestOddsSnapshotTime: card.latestOddsSnapshotTime,
    latestModelRunTime: card.latestModelRunTime,
    hasModelRun: card.hasModelRun,
    modelRunsCount: runsQueried ? (runs?.total ?? 0) : null,
    postOffRunsIgnored: runsQueried ? (runs?.postOff ?? 0) : null,
    recommendationCount: card.modelPick ? 1 : 0,
    status: card.status,
    settled: card.status === 'result' || finishPosAvailable,
    finishPosAvailable,
    winnerName: winner ? winner.horse_name : null,
  };
}

async function main(): Promise<void> {
  const args = parseProofArgs(process.argv.slice(2));
  if (args.errors.length > 0 || !args.date) {
    console.error('proof:day — READ-ONLY durable proof of when the app refreshed each stage.\n');
    for (const e of args.errors) console.error(`  - ${e}`);
    console.error('\nUsage: npm run proof:day -- --date YYYY-MM-DD [--course <name>]');
    console.error('Read-only: SELECT-only reads, no model run, no DB writes, no commit flag.');
    process.exitCode = 1;
    return;
  }

  loadEnv();
  const date = args.date;
  const wantCourse = args.course ? normalizeCourse(args.course) : null;

  // 1. Meeting race cards (read-only); filter by course.
  const cards: RaceCard[] = [];
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
    }
  } catch (err) {
    console.error(
      `Failed to read races for ${date}: ${err instanceof Error ? err.message : String(err)}\n` +
        '(check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local — read-only access).',
    );
    process.exitCode = 1;
    return;
  }
  const ids = cards.map((c) => c.race_id);
  const offByRace = new Map(cards.map((c) => [c.race_id, c.off_time] as const));

  // 2. Read-only counts + audit probes (graceful on missing tables).
  const runnersFound = await countRunners(ids);
  const storedRunners = await readStoredRunners(ids);
  const modelRuns = await readModelRuns(ids, offByRace);
  const cron = await readCron();
  const mlTraining = await countAuditTable('ml_training_examples', ids);
  const genaiTable = await countAuditTable('genai_commentary', ids);

  const races: ProofRaceInput[] = cards.map((card) =>
    toRaceInput(
      card,
      modelRuns?.get(card.race_id) ?? null,
      modelRuns !== null,
      storedRunners?.get(card.race_id) ?? null,
    ),
  );

  const commentaryFilePath = buildCommentaryPath(date, args.course ?? null);
  const input: DayProofInput = {
    date,
    course: args.course ?? null,
    now: Date.now(),
    races,
    runnersFound,
    cron: { available: cron.available, value: cron.jobs },
    mlTraining,
    genai: {
      commentaryFilePath,
      commentaryFileExists: existsSync(commentaryFilePath),
      table: genaiTable,
    },
  };

  const markdown = renderProofMarkdown(input);
  const outPath = buildProofPath(date, args.course ?? null);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown, 'utf8');
  console.log(`Proof report written (read-only): ${outPath}`);
  console.log(summarizeProof(input));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
