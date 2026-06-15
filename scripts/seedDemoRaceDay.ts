/**
 * LOCAL-ONLY demo race-day seed (Batch K1c).
 *
 * Inserts ONE clearly-synthetic race + 6–8 runners + a market snapshot + quotes
 * (and, by default, a few synthetic tipsters + selections) so you can exercise
 * the dashboard, model run, tipster importer, and explanation panel WITHOUT live
 * Racing API / Betfair credentials. Only Supabase env is needed.
 *
 * NOTHING HERE IS REAL DATA. Every horse/race/tipster name contains "DEMO" or
 * "SYNTHETIC", and rows are stamped with the obvious source label "demo-seed".
 *
 * SAFETY:
 *   - REQUIRES `--confirm-demo`. Without it the script prints usage and exits;
 *     it never runs automatically.
 *   - REFUSES to run when NODE_ENV=production or VERCEL is set, unless `--force`
 *     is ALSO passed (so it cannot seed a production deployment by accident).
 *   - A pure guard (assertAllSynthetic) throws before any write if a name is not
 *     clearly synthetic, so this path can never insert a real-looking row.
 *
 * IDEMPOTENCY: the demo race is keyed by (course, meeting_date=today UTC). On a
 * re-run the existing demo race is REUSED (runners are inserted only if absent),
 * a FRESH market snapshot + quotes are appended (the model reads the latest, so
 * this just refreshes odds), and tipster selections upsert with ignoreDuplicates
 * on (race_id, runner_id, raw_tipster_name). Re-running therefore does not pile
 * up duplicate races/runners/selections; it only adds a new odds snapshot.
 *
 * Usage:
 *   npm run seed:demo -- --confirm-demo
 *   npm run seed:demo -- --confirm-demo --runners 6 --skip-tipsters
 *
 * REQUIRES SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in `.env.local` (or `.env`).
 * Credentials are never logged.
 */

import { randomUUID } from 'node:crypto';

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import {
  assertAllSynthetic,
  buildDemoRunnerSpecs,
  buildDemoTipsterSpecs,
  clampRunnerCount,
  DEMO_COUNTRY,
  DEMO_COURSE,
  DEMO_RACE_NAME,
  DEMO_RUNNER_MAX,
  DEMO_SOURCE_LABEL,
} from '../src/lib/demoSeed';

const RACES_TABLE = 'races';
const RUNNERS_TABLE = 'runners';
const MARKET_SNAPSHOTS_TABLE = 'market_snapshots';
const RUNNER_QUOTES_TABLE = 'runner_quotes';
const TIPSTERS_TABLE = 'tipsters';
const TIPSTER_SELECTIONS_TABLE = 'tipster_selections';

/** Loads env from .env.local then .env (first found wins). */
function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      // Try the next; fall back to the shell environment.
    }
  }
}

interface Args {
  confirmDemo: boolean;
  force: boolean;
  skipTipsters: boolean;
  runners?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { confirmDemo: false, force: false, skipTipsters: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm-demo') args.confirmDemo = true;
    else if (a === '--force') args.force = true;
    else if (a === '--skip-tipsters') args.skipTipsters = true;
    else if (a === '--runners') args.runners = Number(argv[++i]);
  }
  return args;
}

/** Today's calendar date (UTC) as YYYY-MM-DD. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.confirmDemo) {
    console.error(
      'This LOCAL-ONLY script inserts clearly-synthetic demo data into Supabase.\n' +
        'It never runs automatically. Re-run with the explicit flag:\n\n' +
        '  npm run seed:demo -- --confirm-demo\n\n' +
        'Options: --runners <6-8>  --skip-tipsters  --force (allow in production)',
    );
    process.exitCode = 1;
    return;
  }

  loadEnv();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local (or .env).',
    );
    process.exitCode = 1;
    return;
  }

  // Production guard: never seed a production deployment unless explicitly forced.
  const looksProd =
    process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
  if (looksProd && !args.force) {
    console.error(
      'Refusing to seed: this looks like a production environment ' +
        '(NODE_ENV=production or VERCEL set). Re-run with --force only if you ' +
        'really intend to insert DEMO data here.',
    );
    process.exitCode = 1;
    return;
  }

  const meetingDate = todayUtc();
  const runnerCount = clampRunnerCount(args.runners);

  // Safety gate: every synthetic name must be clearly marked before any write.
  const runnerSpecs = buildDemoRunnerSpecs(runnerCount);
  const tipsterSpecs = args.skipTipsters ? [] : buildDemoTipsterSpecs();
  assertAllSynthetic([
    DEMO_COURSE,
    DEMO_RACE_NAME,
    ...runnerSpecs.map((r) => r.horse_name),
    ...tipsterSpecs.map((t) => t.canonical_name),
  ]);

  console.log('Demo race-day seed — LOCAL ONLY (all data is SYNTHETIC).\n');

  // 1. Race (idempotent on course + meeting_date=today).
  const { data: existingRace, error: raceLookupErr } = await supabaseAdmin
    .from(RACES_TABLE)
    .select('id, off_time')
    .eq('course', DEMO_COURSE)
    .eq('meeting_date', meetingDate)
    .limit(1);
  if (raceLookupErr) throw new Error(`races lookup failed: ${raceLookupErr.message}`);

  let raceId: string;
  let offTimeIso: string;
  let raceReused = false;
  if (existingRace && existingRace.length > 0) {
    const row = existingRace[0] as { id: string; off_time: string | null };
    raceId = String(row.id);
    offTimeIso = row.off_time ?? new Date(Date.now() + 90 * 60 * 1000).toISOString();
    raceReused = true;
    console.log(`Reusing existing demo race ${raceId} (${DEMO_COURSE}, ${meetingDate}).`);
  } else {
    raceId = randomUUID();
    // Off time ~90 min from now so the dashboard countdown is meaningful.
    offTimeIso = new Date(Date.now() + 90 * 60 * 1000).toISOString();
    const { error: raceErr } = await supabaseAdmin.from(RACES_TABLE).insert({
      id: raceId,
      meeting_date: meetingDate,
      course: DEMO_COURSE,
      country: DEMO_COUNTRY,
      race_name: DEMO_RACE_NAME,
      off_time: offTimeIso,
      handicap_flag: false,
      status: 'scheduled',
    });
    if (raceErr) throw new Error(`races insert failed: ${raceErr.message}`);
    console.log(`Inserted demo race ${raceId} (${DEMO_COURSE}, ${meetingDate}).`);
  }

  // 2. Runners (insert only when the race has none, so re-runs don't duplicate).
  const { data: existingRunners, error: runnersLookupErr } = await supabaseAdmin
    .from(RUNNERS_TABLE)
    .select('id, horse_name')
    .eq('race_id', raceId);
  if (runnersLookupErr) throw new Error(`runners lookup failed: ${runnersLookupErr.message}`);

  let runners: { id: string; horse_name: string }[];
  if (existingRunners && existingRunners.length > 0) {
    runners = (existingRunners as { id: string; horse_name: string }[]).map((r) => ({
      id: String(r.id),
      horse_name: r.horse_name,
    }));
    console.log(`Reusing ${runners.length} existing demo runner(s).`);
  } else {
    const rows = runnerSpecs.map((spec) => ({
      id: randomUUID(),
      race_id: raceId,
      horse_name: spec.horse_name,
      trainer: 'DEMO Trainer (SYNTHETIC)',
      jockey: 'DEMO Jockey (SYNTHETIC)',
      runner_status: 'declared',
    }));
    const { error: runnersErr } = await supabaseAdmin.from(RUNNERS_TABLE).insert(rows);
    if (runnersErr) throw new Error(`runners insert failed: ${runnersErr.message}`);
    runners = rows.map((r) => ({ id: r.id, horse_name: r.horse_name }));
    console.log(`Inserted ${runners.length} demo runner(s).`);
  }

  // 3. Market snapshot (always fresh; the model reads the latest snapshot).
  const snapshotId = randomUUID();
  const { error: snapErr } = await supabaseAdmin.from(MARKET_SNAPSHOTS_TABLE).insert({
    id: snapshotId,
    race_id: raceId,
    snapshot_time: new Date().toISOString(),
    source_label: DEMO_SOURCE_LABEL,
  });
  if (snapErr) throw new Error(`market_snapshots insert failed: ${snapErr.message}`);

  // 4. Quotes: map each runner (by demo index in its name) to a ladder price.
  const oddsByName = new Map(
    buildDemoRunnerSpecs(DEMO_RUNNER_MAX).map((s) => [s.horse_name, s.odds_decimal]),
  );
  const quoteRows = runners
    .map((r) => ({ runner: r, odds: oddsByName.get(r.horse_name) }))
    .filter((x): x is { runner: { id: string; horse_name: string }; odds: number } =>
      typeof x.odds === 'number',
    )
    .map((x) => ({
      id: randomUUID(),
      snapshot_id: snapshotId,
      runner_id: x.runner.id,
      quote_type: DEMO_SOURCE_LABEL,
      odds_decimal: x.odds,
    }));
  if (quoteRows.length > 0) {
    const { error: quotesErr } = await supabaseAdmin.from(RUNNER_QUOTES_TABLE).insert(quoteRows);
    if (quotesErr) throw new Error(`runner_quotes insert failed: ${quotesErr.message}`);
  }
  console.log(`Inserted market snapshot ${snapshotId} with ${quoteRows.length} quote(s).`);

  // 5. Tipsters + selections (optional; clearly synthetic; idempotent).
  if (!args.skipTipsters && tipsterSpecs.length > 0 && runners.length > 0) {
    const tipsterIds: string[] = [];
    for (const spec of tipsterSpecs) {
      const { data: found, error: findErr } = await supabaseAdmin
        .from(TIPSTERS_TABLE)
        .select('id')
        .eq('canonical_name', spec.canonical_name)
        .limit(1);
      if (findErr) throw new Error(`tipsters lookup failed: ${findErr.message}`);

      if (found && found.length > 0) {
        tipsterIds.push(String((found[0] as { id: string }).id));
      } else {
        const id = randomUUID();
        const nowIso = new Date().toISOString();
        const { error: insErr } = await supabaseAdmin.from(TIPSTERS_TABLE).insert({
          id,
          canonical_name: spec.canonical_name,
          display_name: spec.display_name,
          affiliation: spec.affiliation,
          is_active: true,
          first_seen_at: nowIso,
          last_seen_at: nowIso,
        });
        if (insErr) throw new Error(`tipsters insert failed: ${insErr.message}`);
        tipsterIds.push(id);
      }
    }

    // Each demo tipster backs one of the first few runners (deterministic).
    const nowIso = new Date().toISOString();
    const selectionRows = tipsterIds.map((tipsterId, i) => {
      const runner = runners[i % runners.length];
      const spec = tipsterSpecs[i];
      return {
        race_id: raceId,
        runner_id: runner.id,
        tipster_id: tipsterId,
        raw_tipster_name: spec.canonical_name,
        raw_affiliation: spec.affiliation,
        source_label: DEMO_SOURCE_LABEL,
        created_at: nowIso,
      };
    });
    const { error: selErr } = await supabaseAdmin
      .from(TIPSTER_SELECTIONS_TABLE)
      .upsert(selectionRows, {
        onConflict: 'race_id,runner_id,raw_tipster_name',
        ignoreDuplicates: true,
      });
    if (selErr) throw new Error(`tipster_selections upsert failed: ${selErr.message}`);
    console.log(
      `Ensured ${tipsterIds.length} demo tipster(s) and ${selectionRows.length} selection(s).`,
    );
  } else if (args.skipTipsters) {
    console.log('Skipped tipsters (--skip-tipsters).');
  }

  // Next steps for the operator.
  console.log('\nDone.');
  console.log(`  race_id:      ${raceId}`);
  console.log(`  meeting_date: ${meetingDate}  off_time: ${offTimeIso}`);
  console.log(`  reused race:  ${raceReused ? 'yes' : 'no (newly inserted)'}`);
  console.log('\nRun the model for this race (LOCAL — Supabase only, no Racing API/Betfair):');
  console.log(`  npm run run:model -- ${raceId}`);
  console.log('\nOr via the dev server + API:');
  console.log('  # start the dev server in another terminal: npm run dev');
  console.log(
    `  curl -X POST "http://localhost:3000/api/run-model?race_id=${raceId}"`,
  );
  console.log(
    '  # if CRON_SECRET is set, add:  -H "Authorization: Bearer <your CRON_SECRET>"',
  );
  console.log('\nThen open http://localhost:3000 to see the demo race on the dashboard.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
