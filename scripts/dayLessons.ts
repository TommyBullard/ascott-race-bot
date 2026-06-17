/**
 * CLI (READ-ONLY): summarise a completed race day into LESSONS for model / site
 * improvement. RESEARCH / DECISION-SUPPORT ONLY.
 *
 * For a meeting day (optionally one course) it reads — via the shared read-only
 * {@link fetchRaceCard} and {@link computeModelPerformance} — each race's model
 * pick, market favourite, alternatives and full field with recorded finishing
 * positions, plus the day's final performance summary. It then writes a
 * deterministic Markdown report: a performance recap, race-by-race notes, a
 * factual pattern analysis, win-vs-value-vs-place observations, future action
 * ideas, and safety disclaimers.
 *
 * STRICTLY READ-ONLY. It issues only `select` queries (through `fetchRaceCard`,
 * `computeModelPerformance`, and a single read-only `races` lookup for the
 * handicap flag); it NEVER runs the model, fetches live odds, calls an external
 * API, imports results, mutates the database, runs any pipeline, or settles
 * results. The only write is the Markdown file. It loads credentials from
 * `.env.local` / `.env` and never prints them.
 *
 * Usage:
 *   npm run lessons:day -- --date 2026-06-17 --course Ascot
 *
 * Output (deterministic):
 *   reports/day-lessons-2026-06-17-ascot.md
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { normalizeCourse } from '../src/lib/raceSync';
import {
  fetchRaceCard,
  computeModelPerformance,
  type RaceCard,
  type RaceCardRunner,
} from '../src/lib/raceData';
import {
  parseDayLessonsArgs,
  buildDayLessonsPath,
  buildDayLessonsReport,
  renderDayLessonsMarkdown,
  DAY_LESSONS_EVALUATION_MODE,
  type DayLessonsRace,
  type DayLessonsRunner,
  type DayLessonsPick,
} from '../src/lib/dayLessons';

const RACES_TABLE = 'races';
const RACE_MEETING_DATE_COLUMN = 'meeting_date';

/** Loads env from `.env.local`, then `.env`; falls back to the shell env. */
function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      // Not present; try the next, then fall back to shell env.
    }
  }
}

/** One race row read for the handicap flag + meeting listing (read-only). */
interface RaceRow {
  id: string | number;
  handicap_flag: boolean | null;
}

/** Maps a read-only card runner to the lessons runner shape. */
function toRunner(r: RaceCardRunner): DayLessonsRunner {
  return {
    runner_id: String(r.runner_id),
    horse_name: r.horse_name,
    odds: r.odds ?? null,
    ev: r.ev ?? null,
    finish_pos: r.finish_pos ?? null,
  };
}

/** Maps a card's rank-1 pick to the lessons pick shape (null-safe). */
function toPick(card: RaceCard): DayLessonsPick | null {
  if (!card.modelPick) return null;
  return {
    ...toRunner(card.modelPick),
    confidence_label: card.modelPick.confidence_label ?? null,
    stake: card.modelPick.stake_amount ?? null,
    is_favourite: card.modelPick.isFavourite === true,
  };
}

/** Reads the tipster/model alignment label from the run's observability, or null. */
function alignmentLabel(card: RaceCard): string | null {
  const alignment = card.observability?.tipsterModelAlignment;
  const label = alignment && typeof alignment === 'object' ? alignment['alignment_label'] : undefined;
  return typeof label === 'string' ? label : null;
}

/** Resolves one race card into the read-only lessons input. Pure mapping. */
function toLessonsRace(card: RaceCard, isHandicap: boolean | null): DayLessonsRace {
  const runners = card.runners ?? [];
  const winner = runners.find((r) => r.finish_pos === 1) ?? null;
  const hasResult =
    (card.status ?? '').trim().toLowerCase() === 'result' ||
    runners.some((r) => typeof r.finish_pos === 'number' && Number.isFinite(r.finish_pos));

  return {
    race_id: card.race_id,
    race_name: card.race_name,
    course: card.course,
    off_time: card.off_time,
    status: card.status ?? null,
    field_size: runners.length,
    is_handicap: isHandicap,
    has_result: hasResult,
    winner_name: winner ? winner.horse_name : null,
    pick: toPick(card),
    favourite: card.favourite ? toRunner(card.favourite) : null,
    alternatives: card.alternatives.map(toRunner),
    run_quality: card.observability?.runQuality ?? null,
    tipster_alignment_label: alignmentLabel(card),
  };
}

async function main(): Promise<void> {
  const args = parseDayLessonsArgs(process.argv.slice(2));
  if (!args.date) {
    console.error(
      'Usage: npm run lessons:day -- --date <YYYY-MM-DD> [--course <name>]\n' +
        '(read-only research report; summarises a completed day into lessons; writes Markdown; no DB writes, no betting advice).',
    );
    process.exitCode = 1;
    return;
  }

  loadEnv();

  const date = args.date;
  const wantCourse = args.course ? normalizeCourse(args.course) : null;

  // 1. Read the meeting's races for the id list + handicap flag (read-only).
  let raceRows: RaceRow[];
  try {
    const { data, error } = await supabaseAdmin
      .from(RACES_TABLE)
      .select('id, handicap_flag')
      .eq(RACE_MEETING_DATE_COLUMN, date);
    if (error) throw new Error(error.message);
    raceRows = (data ?? []) as RaceRow[];
  } catch (err) {
    console.error(
      `Failed to read races for ${date}: ${err instanceof Error ? err.message : String(err)}\n` +
        '(check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local — read-only access).',
    );
    process.exitCode = 1;
    return;
  }

  const handicapById = new Map<string, boolean | null>();
  for (const row of raceRows) {
    handicapById.set(
      String(row.id),
      typeof row.handicap_flag === 'boolean' ? row.handicap_flag : null,
    );
  }

  // 2. Build each race card concurrently; isolate per-race failures.
  const raceIds = raceRows.map((r) => String(r.id));
  const settled = await Promise.allSettled(raceIds.map((id) => fetchRaceCard(id)));

  const races: DayLessonsRace[] = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled') {
      console.error('Skipped a race (read failed):', result.reason);
      continue;
    }
    const card = result.value;
    if (wantCourse && normalizeCourse(card.course) !== wantCourse) continue;
    races.push(toLessonsRace(card, handicapById.get(card.race_id) ?? null));
  }

  // 3. The day's final performance summary (pre-off; reuses the shared maths).
  let performance;
  try {
    performance = await computeModelPerformance({
      date,
      course: args.course ?? null,
      mode: DAY_LESSONS_EVALUATION_MODE,
    });
  } catch (err) {
    console.error(
      `Failed to compute performance for ${date}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  // 4. Assemble + render the deterministic report.
  const report = buildDayLessonsReport({
    date,
    course: args.course ?? null,
    generatedAt: new Date().toISOString(),
    performance,
    races,
  });
  const markdown = renderDayLessonsMarkdown(report);

  const outPath = buildDayLessonsPath(date, args.course);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown, 'utf8');

  const p = report.performance;
  console.log(`Race-day lessons written (read-only, research only): ${outPath}`);
  console.log(
    `  races: ${report.races.length} · settled: ${p.settled_count} · winners ${p.winners}/losers ${p.losers} · ` +
      `P/L ${p.profit_loss.toFixed(2)}pt · ROI ${p.roi.toFixed(1)}% · mode ${p.evaluationMode}`,
  );
}

main().catch((err) => {
  console.error('lessons:day failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
