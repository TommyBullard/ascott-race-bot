/**
 * LIVE verification harness for The Racing API tipster adapter.
 *
 * Runs the REAL adapter against the live API (using RACING_API_USER /
 * RACING_API_KEY from `.env.local`), feeds the signals through the exact
 * `discoverTipsters` path the cron uses, and prints the top 10 by final weight
 * so the numbers can be eyeballed.
 *
 * SAFE BY DEFAULT: this is a dry run (fetch + score, NO writes) unless you pass
 * `--commit`, mirroring the seed script. The verification gate (100+ rows,
 * sane dedupe, scored, persisted) is satisfied with `--commit`.
 *
 * Requires (in `.env.local`):
 *   RACING_API_USER + RACING_API_KEY        (Standard+ plan for analysis)
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (for dedupe + persistence)
 *
 * Usage:
 *   npm run verify:racing                 # dry run, default caps
 *   npm run verify:racing -- --max 80     # dry run, 80 trainers + 80 jockeys
 *   npm run verify:racing -- --commit     # persist via discoverTipsters
 *   npm run verify:racing -- --no-short   # skip the 7d window (fewer requests)
 */

import { discoverTipsters } from '../src/lib/discoverTipsters';
import { fetchRacingApiSignals } from '../src/lib/racingApi';

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
  commit: boolean;
  noShort: boolean;
  max?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { commit: false, noShort: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--commit') args.commit = true;
    else if (arg === '--no-short') args.noShort = true;
    else if (arg === '--max') {
      const n = Number(argv[++i]);
      if (Number.isInteger(n) && n > 0) args.max = n;
    }
  }
  return args;
}

function fmtPct(value: number | undefined | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.RACING_API_USER || !process.env.RACING_API_KEY) {
    console.error(
      'BLOCKED: missing RACING_API_USER / RACING_API_KEY in .env.local.\n' +
        'Add your Racing API credentials (Standard+ plan) and re-run. This\n' +
        'harness never fabricates data, so it cannot verify without them.',
    );
    process.exit(1);
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('BLOCKED: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local.');
    process.exit(1);
  }

  const maxTrainers = args.max ?? 80;
  const maxJockeys = args.max ?? 80;

  console.log('--- Racing API adapter: LIVE verification ---');
  console.log(
    `mode=${args.commit ? 'COMMIT (persists)' : 'dry-run (no writes)'} ` +
      `maxTrainers=${maxTrainers} maxJockeys=${maxJockeys} ` +
      `shortWindow=${args.noShort ? 'off' : '7d'}`,
  );

  const signals = await fetchRacingApiSignals({
    maxTrainers,
    maxJockeys,
    shortWindowDays: args.noShort ? null : 7,
    onProgress: (msg) => console.log(`[fetch] ${msg}`),
  });

  console.log(`\nfetched ${signals.length} signals from The Racing API`);
  console.log(
    signals.length >= 100
      ? 'PASS: returned 100+ signals'
      : `NOTE: ${signals.length} signals (raise --max or run on a busier race day for 100+)`,
  );

  // Enrich the printout with the underlying numbers (by signal name).
  const byName = new Map(signals.map((s) => [s.name, s]));

  const result = await discoverTipsters(signals, { dryRun: !args.commit });
  console.log(
    `\ndedupe: received=${result.received} deduped=${result.deduped} ` +
      `promoted=${result.promoted} demoted=${result.demoted} ` +
      `written=${result.written} asOf=${result.asOfDate}`,
  );

  console.log('\nTop 10 by final weight:');
  console.log(
    'rank  finalWeight  needle   reliab  bets   longROI  rec30d  rec7d  name',
  );
  for (const [i, row] of result.rows.slice(0, 10).entries()) {
    const s = byName.get(row.name);
    console.log(
      [
        String(i + 1).padStart(4),
        row.finalWeight.toFixed(4).padStart(11),
        row.needleScore.toFixed(3).padStart(7),
        row.reliability.toFixed(3).padStart(7),
        String(s?.betsCount ?? '—').padStart(5),
        fmtPct(s?.longRunRoi).padStart(8),
        fmtPct(s?.recentRoi30d).padStart(7),
        fmtPct(s?.recentRoi7d).padStart(6),
        ` ${row.name}`,
      ].join('  '),
    );
  }

  if (!args.commit) {
    console.log('\n(dry run — nothing persisted; re-run with --commit to write)');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
