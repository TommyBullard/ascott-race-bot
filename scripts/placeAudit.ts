/**
 * CLI (READ-ONLY): each-way / place outcome audit. RESEARCH ONLY.
 *
 * For a meeting day (optionally one course) it joins each race's model pick,
 * market favourite, alternatives and full field — with their FINAL pre-off
 * selection + recorded finishing positions, via the shared read-only
 * {@link fetchRaceCard} — and counts wins / places against a CONFIGURABLE,
 * SIMULATED top-N place marker. It then writes a deterministic Markdown report.
 *
 * STRICTLY READ-ONLY + RESEARCH ONLY. It issues only `select` queries (through
 * `fetchRaceCard` / `fetchRaceIdsForMeeting`); it NEVER runs the model, fetches
 * live odds, calls an external API, imports results, mutates the database, or
 * computes any real each-way payout / P&L. The only write is the Markdown file.
 * It loads credentials from `.env.local` / `.env` and never prints them.
 *
 * Usage:
 *   npm run place:audit -- --date 2026-06-17 --course Ascot --places 4
 *
 * Output (deterministic):
 *   reports/place-audit-2026-06-17-ascot.md
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { fetchRaceIdsForMeeting, fetchRaceCard } from '../src/lib/raceData';
import { normalizeCourse } from '../src/lib/raceSync';
import {
  parsePlaceAuditArgs,
  buildPlaceAuditReport,
  renderPlaceAuditMarkdown,
  buildPlaceAuditPath,
  type AuditRunner,
  type PlaceAuditRaceInput,
} from '../src/lib/placeAudit';

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

/** Maps a read-only card runner to the audit shape (finish position only). */
function toAuditRunner(r: {
  runner_id: string;
  horse_name: string;
  finish_pos: number | null;
}): AuditRunner {
  return {
    runner_id: String(r.runner_id),
    horse_name: r.horse_name,
    finish_pos: r.finish_pos ?? null,
  };
}

async function main(): Promise<void> {
  const args = parsePlaceAuditArgs(process.argv.slice(2));
  if (!args.date) {
    console.error(
      'Usage: npm run place:audit -- --date <YYYY-MM-DD> [--course <name>] [--places <n>]\n' +
        '(read-only research audit; simulated top-N place marker; writes a Markdown report; no DB writes, no payout).',
    );
    process.exitCode = 1;
    return;
  }

  loadEnv();

  const wantCourse = args.course ? normalizeCourse(args.course) : null;

  let raceIds: string[];
  try {
    raceIds = await fetchRaceIdsForMeeting(args.date);
  } catch (err) {
    console.error(
      `Failed to read races for ${args.date}: ${err instanceof Error ? err.message : String(err)}\n` +
        '(check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local — read-only access).',
    );
    process.exitCode = 1;
    return;
  }

  // Build each race card concurrently; isolate per-race failures.
  const settled = await Promise.allSettled(raceIds.map((id) => fetchRaceCard(id)));

  const inputs: PlaceAuditRaceInput[] = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled') {
      console.error('Skipped a race (read failed):', result.reason);
      continue;
    }
    const card = result.value;
    if (wantCourse && normalizeCourse(card.course) !== wantCourse) continue;
    inputs.push({
      race_id: card.race_id,
      off_time: card.off_time,
      race_name: card.race_name,
      course: card.course,
      modelPick: card.modelPick ? toAuditRunner(card.modelPick) : null,
      favourite: card.favourite ? toAuditRunner(card.favourite) : null,
      alternatives: card.alternatives.map(toAuditRunner),
      runners: card.runners.map(toAuditRunner),
      confidenceLabel: card.modelPick?.confidence_label ?? null,
      runQuality: card.observability?.runQuality ?? null,
      status: card.status ?? null,
    });
  }

  const report = buildPlaceAuditReport({
    date: args.date,
    course: args.course,
    inputs,
    config: { places: args.places },
  });
  const markdown = renderPlaceAuditMarkdown(report);

  const outPath = buildPlaceAuditPath(args.date, args.course);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown, 'utf8');

  const s = report.summary;
  console.log(`Place audit written (read-only, research only): ${outPath}`);
  console.log(
    `  places: ${report.places} · races: ${s.raceCount} · settled: ${s.settledRaceCount} · ` +
      `model pick won ${s.modelPickWon}/placed ${s.modelPickPlaced} · ` +
      `favourite won ${s.favouriteWon}/placed ${s.favouritePlaced} · ` +
      `alt won ${s.alternativesWon}/placed ${s.alternativesPlaced}`,
  );
}

main().catch((err) => {
  console.error('place:audit failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
