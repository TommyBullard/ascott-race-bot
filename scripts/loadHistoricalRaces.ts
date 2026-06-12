/**
 * ONE-OFF loader: insert REAL historical race data so the backtest has settled
 * races to score. READ + VALIDATE first; writes only with --commit.
 *
 * It populates exactly the tables the backtest reads:
 *   races, runners (finish_pos + bsp_decimal/sp_decimal), market_snapshots,
 *   runner_quotes (the pre-race price the model scores on), and optionally
 *   tipsters + tipster_priors + tipster_selections (to enable needle weighting).
 *
 * INTEGRITY — NO FABRICATION:
 *   - Every value is taken verbatim from your input file. Missing prices /
 *     results are stored as NULL, never invented.
 *   - If a race has no winner or no priced runner, it is loaded but flagged as
 *     "won't count" — the loader does not complete the result for you.
 *   - --commit is REFUSED when the file still contains placeholder EXAMPLE data,
 *     so the template can't be inserted by accident.
 *
 * IDEMPOTENT: a race already present (matched on course + off_time) is skipped,
 * so re-running never duplicates rows. IDs are generated client-side (uuid) so
 * foreign keys are wired without round-trips.
 *
 * Usage:
 *   npm run load:races -- --file data/historical-races.json            # dry run
 *   npm run load:races -- --file data/historical-races.json --commit   # write
 *
 * REQUIRES SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in `.env.local`.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import {
  validateImport,
  type HistoricalImport,
  type RaceInput,
  type SelectionInput,
  type TipsterInput,
} from '../src/lib/historicalRaceLoader';

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
  file?: string;
  commit: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { commit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') args.commit = true;
    else if (a === '--file') args.file = argv[++i];
  }
  return args;
}

const num = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Inserts one race + children. Returns 'inserted' or 'skipped' (already present). */
async function insertRace(
  race: RaceInput,
  tipsterIdByName: Map<string, string>,
): Promise<'inserted' | 'skipped'> {
  const offTimeIso = new Date(race.off_time).toISOString();

  // Idempotency: skip a race already loaded (matched on course + off_time).
  const { data: existing, error: existErr } = await supabaseAdmin
    .from('races')
    .select('id')
    .eq('course', race.course)
    .eq('off_time', offTimeIso)
    .limit(1);
  if (existErr) throw new Error(`races lookup failed: ${existErr.message}`);
  if (existing && existing.length > 0) return 'skipped';

  const raceId = randomUUID();
  const { error: raceErr } = await supabaseAdmin.from('races').insert({
    id: raceId,
    meeting_date: race.meeting_date,
    course: race.course,
    country: race.country,
    race_name: race.race_name,
    off_time: offTimeIso,
    handicap_flag: race.handicap ?? false,
    status: race.status ?? 'result',
  });
  if (raceErr) throw new Error(`races insert failed: ${raceErr.message}`);

  // Runners (capture id per horse to wire quotes + selections).
  const runnerIdByHorse = new Map<string, string>();
  const runnerRows = race.runners.map((r) => {
    const id = randomUUID();
    runnerIdByHorse.set(r.horse_name.trim().toLowerCase(), id);
    return {
      id,
      race_id: raceId,
      horse_name: r.horse_name,
      trainer: r.trainer ?? null,
      jockey: r.jockey ?? null,
      runner_status: r.status ?? 'ran',
      finish_pos: num(r.finish_pos),
      bsp_decimal: num(r.bsp_decimal),
      sp_decimal: num(r.sp_decimal),
    };
  });
  const { error: runnersErr } = await supabaseAdmin.from('runners').insert(runnerRows);
  if (runnersErr) throw new Error(`runners insert failed: ${runnersErr.message}`);

  // One pre-race market snapshot, then a quote per priced runner.
  const snapshotId = randomUUID();
  const { error: snapErr } = await supabaseAdmin.from('market_snapshots').insert({
    id: snapshotId,
    race_id: raceId,
    snapshot_time: offTimeIso,
    source_label: race.source_label ?? 'historical_import',
  });
  if (snapErr) throw new Error(`market_snapshots insert failed: ${snapErr.message}`);

  const quoteRows = race.runners
    .filter((r) => typeof r.odds_decimal === 'number' && r.odds_decimal > 1)
    .map((r) => ({
      id: randomUUID(),
      snapshot_id: snapshotId,
      runner_id: runnerIdByHorse.get(r.horse_name.trim().toLowerCase()),
      quote_type: race.quote_type ?? 'historical',
      odds_decimal: r.odds_decimal,
    }));
  if (quoteRows.length > 0) {
    const { error: quotesErr } = await supabaseAdmin
      .from('runner_quotes')
      .insert(quoteRows);
    if (quotesErr) throw new Error(`runner_quotes insert failed: ${quotesErr.message}`);
  }

  // Tipster selections (real picks). tipster_id is resolved best-effort:
  // explicit id > supplied-prior name match > null (an unlinked, but real, pick).
  const selections = race.tipster_selections ?? [];
  if (selections.length > 0) {
    const nowIso = new Date().toISOString();
    const selRows = selections.map((s: SelectionInput) => ({
      id: randomUUID(),
      race_id: raceId,
      runner_id: runnerIdByHorse.get(s.horse_name.trim().toLowerCase()),
      tipster_id:
        s.tipster_id ?? tipsterIdByName.get(s.tipster_name.trim().toLowerCase()) ?? null,
      raw_tipster_name: s.tipster_name,
      raw_affiliation: s.affiliation ?? null,
      created_at: nowIso,
    }));
    const { error: selErr } = await supabaseAdmin
      .from('tipster_selections')
      .insert(selRows);
    if (selErr) throw new Error(`tipster_selections insert failed: ${selErr.message}`);
  }

  return 'inserted';
}

/**
 * Ensures each supplied tipster exists (matched by canonical_name) and writes
 * its proofed prior row (upsert on the (tipster_id, as_of_date) PK). Returns a
 * name -> id map so selections can link to the right tipster. Proofed numbers
 * are stored verbatim; nothing is invented.
 */
async function upsertTipsters(
  tipsters: TipsterInput[],
): Promise<Map<string, string>> {
  const idByName = new Map<string, string>();
  for (const t of tipsters) {
    const key = t.canonical_name.trim().toLowerCase();

    const { data: found, error: findErr } = await supabaseAdmin
      .from('tipsters')
      .select('id')
      .eq('canonical_name', t.canonical_name)
      .limit(1);
    if (findErr) throw new Error(`tipsters lookup failed: ${findErr.message}`);

    let tipsterId: string;
    if (found && found.length > 0) {
      tipsterId = String((found[0] as { id: string }).id);
    } else {
      tipsterId = randomUUID();
      const nowIso = new Date().toISOString();
      const { error: insErr } = await supabaseAdmin.from('tipsters').insert({
        id: tipsterId,
        canonical_name: t.canonical_name,
        display_name: t.display_name ?? t.canonical_name,
        affiliation: t.affiliation ?? null,
        is_active: true,
        first_seen_at: nowIso,
        last_seen_at: nowIso,
      });
      if (insErr) throw new Error(`tipsters insert failed: ${insErr.message}`);
    }
    idByName.set(key, tipsterId);

    const { error: priorErr } = await supabaseAdmin.from('tipster_priors').upsert(
      {
        tipster_id: tipsterId,
        as_of_date: t.as_of_date,
        bets_count: t.bets_count,
        wins_count: t.wins_count,
        roi_bsp_gross: num(t.roi_bsp_gross),
        roi_bsp_net: num(t.roi_bsp_net),
        ae_bsp: num(t.ae_bsp),
        strike_rate: num(t.strike_rate),
      },
      { onConflict: 'tipster_id,as_of_date' },
    );
    if (priorErr) throw new Error(`tipster_priors upsert failed: ${priorErr.message}`);
  }
  return idByName;
}

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));

  if (!args.file) {
    console.error('Usage: npm run load:races -- --file <path.json> [--commit]');
    process.exit(1);
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local.');
    process.exit(1);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(args.file, 'utf8'));
  } catch (err) {
    console.error(`Failed to read/parse ${args.file}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const result = validateImport(raw);

  console.log('');
  console.log('=== Historical race loader ===');
  console.log(`File: ${args.file}`);
  console.log(`Mode: ${args.commit ? 'COMMIT (writes to DB)' : 'DRY RUN (no writes)'}`);
  console.log('');

  // Per-race classification, mirroring the backtest's "counts" rule.
  for (const r of result.races) {
    const verdict = r.wouldCount ? 'COUNTS' : "WON'T COUNT";
    const winner = r.winnerHorse
      ? `winner=${r.winnerHorse}${r.winnerHasBsp ? ' (BSP set)' : ' (no BSP)'}`
      : 'no winner';
    console.log(
      `  [${verdict}] ${r.label} — ${r.runnerCount} runners, ${r.pricedCount} priced, ` +
        `${winner}, ${r.selectionCount} selection(s) (${r.linkableSelectionCount} linkable)`,
    );
  }
  console.log('');
  console.log(
    `Parsed: ${result.races.length} race(s); ${result.countable} would COUNT in the backtest; ` +
      `${result.tipsterCount} tipster prior(s).`,
  );

  if (result.warnings.length > 0) {
    console.log('');
    console.log('Warnings (non-blocking):');
    for (const w of result.warnings) console.log(`  - ${w}`);
  }

  if (result.errors.length > 0) {
    console.log('');
    console.log(`ERRORS (${result.errors.length}) — nothing will be written:`);
    for (const e of result.errors) console.log(`  - ${e}`);
    process.exit(1);
  }

  if (!args.commit) {
    console.log('');
    console.log('DRY RUN complete — input is valid. Re-run with --commit to write.');
    return;
  }

  if (result.hasPlaceholder) {
    console.log('');
    console.error(
      'REFUSING to commit: placeholder "EXAMPLE" data detected. Replace the ' +
        'template values with real data before using --commit.',
    );
    process.exit(1);
  }

  // ---- Commit ---------------------------------------------------------------
  const data = raw as HistoricalImport;
  const tipsterIdByName = await upsertTipsters(data.tipsters ?? []);

  let inserted = 0;
  let skipped = 0;
  for (const race of data.races) {
    const outcome = await insertRace(race, tipsterIdByName);
    if (outcome === 'inserted') inserted++;
    else skipped++;
  }

  console.log('');
  console.log(
    `COMMIT complete: ${inserted} race(s) inserted, ${skipped} skipped (already present), ` +
      `${tipsterIdByName.size} tipster(s) linked.`,
  );
  console.log('Next: run `npm run backtest` to score them (needle vs control).');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
