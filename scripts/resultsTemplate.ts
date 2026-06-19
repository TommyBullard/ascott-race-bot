/**
 * CLI (READ-ONLY): manual results CSV template generator.
 *
 * Reads stored races + runners for a meeting and writes a LOCAL CSV TEMPLATE
 * (one row per runner, identity columns pre-filled, result columns blank) plus a
 * companion Markdown guide, so an operator can hand-fill official results for
 * days where automated settlement is unavailable and then import them via
 * `import:results`.
 *
 * STRICTLY READ-ONLY. It issues only `select` reads; it NEVER writes the
 * database, NEVER marks a race settled, NEVER writes a result, runs no model,
 * calls no external API, and passes no commit flag. The only writes are the local
 * CSV + Markdown files. Credentials load from `.env.local` / `.env` and are never
 * printed.
 *
 * Usage:
 *   npm run results:template -- --date YYYY-MM-DD --course COURSE [--output data/results-<date>-<course>.csv]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { normalizeCourse } from '../src/lib/raceSync';
import {
  parseTemplateArgs,
  buildTemplatePath,
  buildCompanionPath,
  buildTemplateRows,
  renderTemplateCsv,
  buildTemplateReadme,
  TEMPLATE_WARNING,
  type TemplateRunner,
} from '../src/lib/resultsTemplate';

const RACES_TABLE = 'races';
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

interface RaceRow {
  id: string;
  off_time: string | null;
  course: string | null;
  race_name: string | null;
}

interface RunnerRow {
  race_id: string;
  horse_name: string;
  saddlecloth: number | null;
}

async function main(): Promise<void> {
  const args = parseTemplateArgs(process.argv.slice(2));
  if (args.errors.length > 0 || !args.date) {
    console.error('results:template — READ-ONLY manual results CSV template generator.\n');
    for (const e of args.errors) console.error(`  - ${e}`);
    console.error('\nUsage: npm run results:template -- --date YYYY-MM-DD [--course <name>] [--output <file.csv>]');
    console.error('Read-only: SELECT-only reads; writes a local CSV + Markdown only; no DB writes, no settlement, no commit flag.');
    process.exitCode = 1;
    return;
  }

  loadEnv();
  const date = args.date;
  const wantCourse = args.course ? normalizeCourse(args.course) : null;

  // 1. Read stored races for the meeting (read-only); filter by course.
  let races: RaceRow[];
  try {
    const { data, error } = await supabaseAdmin
      .from(RACES_TABLE)
      .select('id, off_time, course, race_name')
      .eq('meeting_date', date);
    if (error) throw new Error(error.message);
    races = ((data ?? []) as RaceRow[]).filter(
      (r) => !wantCourse || normalizeCourse(r.course) === wantCourse,
    );
  } catch (err) {
    console.error(
      `Failed to read races for ${date}: ${err instanceof Error ? err.message : String(err)}\n` +
        '(check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local — read-only access).',
    );
    process.exitCode = 1;
    return;
  }

  const ids = races.map((r) => r.id);
  const offByRace = new Map(races.map((r) => [r.id, r.off_time] as const));

  // 2. Read stored runners for those races (read-only).
  let runnerRows: RunnerRow[] = [];
  if (ids.length > 0) {
    const { data, error } = await supabaseAdmin
      .from(RUNNERS_TABLE)
      .select('race_id, horse_name, saddlecloth')
      .in('race_id', ids);
    if (error) {
      console.error(`Failed to read runners: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    runnerRows = (data ?? []) as RunnerRow[];
  }

  // 3. Build the template (identity pre-filled, results blank). No DB writes.
  const courseLabel = races.find((r) => r.course)?.course ?? args.course ?? '';
  const runners: TemplateRunner[] = runnerRows.map((r) => ({
    offTime: offByRace.get(r.race_id) ?? null,
    horseName: r.horse_name,
    saddlecloth: typeof r.saddlecloth === 'number' ? r.saddlecloth : null,
  }));
  const rows = buildTemplateRows({ date, course: courseLabel, runners });
  const csv = renderTemplateCsv(rows);

  const csvPath = args.output ?? buildTemplatePath(date, args.course ?? courseLabel ?? null);
  const readmePath = buildCompanionPath(csvPath);
  const readme = buildTemplateReadme({
    date,
    course: courseLabel || (args.course ?? null),
    csvPath,
    raceCount: races.length,
    runnerCount: rows.length,
  });

  mkdirSync(dirname(csvPath), { recursive: true });
  writeFileSync(csvPath, csv, 'utf8');
  mkdirSync(dirname(readmePath), { recursive: true });
  writeFileSync(readmePath, readme, 'utf8');

  console.log(`Template written (read-only): ${csvPath}`);
  console.log(`Fill guide written: ${readmePath}`);
  console.log(`  ${races.length} race(s), ${rows.length} runner row(s).`);
  if (rows.length === 0) {
    console.log('  WARNING: no stored races/runners matched — the template has headers only.');
  }
  console.log(`\n${TEMPLATE_WARNING}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
