/**
 * `verify:tipster-match` — READ-ONLY verification of tipster-selection coverage.
 *
 * For a date (+ optional course), it reports how many tipster_selections are
 * matched to those races, which races would form a consensus, which runners have
 * support, and whether NO_TIPSTER_CONSENSUS would clear once the model re-runs.
 *
 * It writes NOTHING, runs no model, and changes no math: it issues only `select`
 * reads and reuses the same pure {@link summarizeTipsterMatch} / consensus logic
 * the live run uses. Credentials are never logged.
 *
 * Usage:
 *   npm run verify:tipster-match -- --date 2026-06-19 --course Ascot
 */

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { normalizeCourse } from '../src/lib/raceSync';
import {
  summarizeTipsterMatch,
  renderTipsterMatchSummary,
  type VerifyRaceInput,
} from '../src/lib/tipsterMatchVerify';

function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      /* next */
    }
  }
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let date: string | undefined;
  let course: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--date') date = (argv[++i] ?? '').trim();
    else if (argv[i] === '--course') course = (argv[++i] ?? '').trim();
  }
  if (!date || !isValidIsoDate(date)) {
    console.error('Usage: npm run verify:tipster-match -- --date YYYY-MM-DD [--course <name>]');
    process.exitCode = 1;
    return;
  }

  loadEnv();
  const wantCourse = course ? normalizeCourse(course) : null;

  const { data: raceRows, error: raceErr } = await supabaseAdmin
    .from('races')
    .select('id, race_name, off_time, course')
    .eq('meeting_date', date)
    .order('off_time', { ascending: true });
  if (raceErr) {
    console.error(`Failed to read races: ${raceErr.message}`);
    process.exitCode = 1;
    return;
  }

  const races = (raceRows ?? []).filter(
    (r) => !wantCourse || (r.course ? normalizeCourse(r.course) : '') === wantCourse,
  );

  const inputs: VerifyRaceInput[] = [];
  for (const race of races) {
    const { data: runnerRows } = await supabaseAdmin
      .from('runners')
      .select('id, horse_name')
      .eq('race_id', race.id);
    const { data: selRows } = await supabaseAdmin
      .from('tipster_selections')
      .select('runner_id')
      .eq('race_id', race.id);

    const runnerNames: Record<string, string | null> = {};
    for (const r of runnerRows ?? []) runnerNames[String(r.id)] = r.horse_name ?? null;

    inputs.push({
      raceId: String(race.id),
      raceName: race.race_name ?? null,
      offTime: race.off_time ?? null,
      runnerIds: (runnerRows ?? []).map((r) => String(r.id)),
      runnerNames,
      tipsterSelections: (selRows ?? []).map((s) => ({ runner_id: String(s.runner_id) })),
    });
  }

  const summary = summarizeTipsterMatch(date, course ?? null, inputs);
  console.log(renderTipsterMatchSummary(summary));
  console.log('\n(read-only) No model run, no database writes. Tipster selections become model-active');
  console.log('on the next model run once matched selections are imported in write mode.');
}

main().catch((err) => {
  console.error(`verify:tipster-match failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exitCode = 1;
});
