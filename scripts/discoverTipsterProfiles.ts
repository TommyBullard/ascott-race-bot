/**
 * Tipster Discovery Engine operator CLI (Phase 4C).
 *
 * Discovers publicly available racing tipsters from configured, ToS-compliant
 * sources and captures them into the REVIEW tables only. It is decision support
 * only: it never calls the model, never changes staking, never makes a tipster
 * model-active, and never fabricates a metric.
 *
 * SAFETY:
 *   - READ-ONLY BY DEFAULT (dry run). It prints what it WOULD capture and writes
 *     NOTHING unless `--commit` is passed.
 *   - APPROVAL-GATED WRITES. With `--commit`, the source must be registered in
 *     `tipster_source_registry` AND approved (`is_approved`) AND opted into
 *     discovery (`supports_discovery`). Otherwise the run refuses to persist —
 *     nothing enters the queue from an unvetted feed.
 *   - WRITES ONLY `tipster_discovery_runs` + `tipster_discovery_candidates`.
 *     Promotion of a captured profile to a (still INACTIVE) canonical tipster is
 *     a separate, explicit operator step.
 *
 * The only configured source today is The Racing API "connections" feed
 * (trainer/jockey course-analysis). Other platforms remain unimplemented adapters
 * by design — discovery never runs on invented numbers.
 *
 * Usage:
 *   # Dry run (default) — score + print, write nothing:
 *   npm run discover:tipsters
 *   npm run discover:tipsters -- --recent-window 30 --long-window 365
 *
 *   # Register + approve the source ONCE (via the review CLI), then commit:
 *   npm run review:tipster-candidates -- --add-source \
 *     --source-label racing-api-connections --source-name "The Racing API — connections" --commit
 *   npm run review:tipster-candidates -- --approve-source racing-api-connections --commit
 *   #   (then set supports_discovery=true for the source — see docs)
 *   npm run discover:tipsters -- --commit
 *
 * REQUIRES SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY and, for the Racing API
 * source, RACING_API_USER + RACING_API_KEY in `.env.local` (or `.env`).
 * Credentials are never logged.
 */

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import {
  createDiscoveryDeps,
  racingApiDiscoverySource,
  runTipsterDiscovery,
  RACING_API_DISCOVERY_SOURCE_LABEL,
  type DiscoverySource,
} from '../src/lib/tipsterDiscovery';

const SOURCE_REGISTRY_TABLE = 'tipster_source_registry';

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
  help: boolean;
  source: string;
  longWindowDays: number;
  recentWindowDays: number;
  maxTrainers?: number;
  maxJockeys?: number;
  limit?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    commit: false,
    help: false,
    source: RACING_API_DISCOVERY_SOURCE_LABEL,
    longWindowDays: 365,
    recentWindowDays: 30,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') args.commit = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--source') args.source = (argv[++i] ?? '').trim();
    else if (a === '--long-window') args.longWindowDays = Number(argv[++i] ?? '365');
    else if (a === '--recent-window') args.recentWindowDays = Number(argv[++i] ?? '30');
    else if (a === '--max-trainers') args.maxTrainers = Number(argv[++i]);
    else if (a === '--max-jockeys') args.maxJockeys = Number(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
  }
  return args;
}

/** Resolves the configured source adapter for a label, or null if unknown. */
function resolveSource(args: Args): DiscoverySource | null {
  if (args.source === RACING_API_DISCOVERY_SOURCE_LABEL) {
    return racingApiDiscoverySource({
      longWindowDays: args.longWindowDays,
      recentWindowDays: args.recentWindowDays,
      maxTrainers: args.maxTrainers,
      maxJockeys: args.maxJockeys,
    });
  }
  return null;
}

/** Reads the registry trust flags for a source label (read-only). */
async function readSourceTrust(
  sourceLabel: string,
): Promise<{ registered: boolean; approved: boolean; supportsDiscovery: boolean }> {
  const { data, error } = await supabaseAdmin
    .from(SOURCE_REGISTRY_TABLE)
    .select('is_approved, supports_discovery')
    .eq('source_label', sourceLabel)
    .limit(1);
  if (error) {
    throw new Error(`Failed to read source registry: ${error.message}`);
  }
  const row = (data ?? [])[0] as
    | { is_approved: boolean | null; supports_discovery: boolean | null }
    | undefined;
  return {
    registered: row !== undefined,
    approved: row?.is_approved === true,
    supportsDiscovery: row?.supports_discovery === true,
  };
}

/** Formats a fraction as a signed percent, or '—' when null. */
function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

/** Formats a nullable number, or '—'. */
function numOr(value: number | null): string {
  return value === null ? '—' : String(value);
}

function printHelp(): void {
  console.log(
    [
      'Tipster Discovery Engine — capture publicly available tipsters into review tables.',
      '',
      'Dry run by default (writes nothing). Add --commit to persist to the review tables',
      '(requires the source to be registered + approved + discovery-enabled).',
      '',
      'Options:',
      '  --commit                 Persist captured candidates (otherwise dry run).',
      `  --source <label>         Source to crawl (default ${RACING_API_DISCOVERY_SOURCE_LABEL}).`,
      '  --long-window <days>     Long-run analysis window (default 365).',
      '  --recent-window <days>   Recent momentum window (default 30).',
      '  --max-trainers <n>       Cap trainers enumerated from the cards.',
      '  --max-jockeys <n>        Cap jockeys enumerated from the cards.',
      '  --limit <n>              Only print the top n rows (by confidence).',
      '  --help                   Show this help.',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const source = resolveSource(args);
  if (!source) {
    console.error(
      `Unknown / unconfigured source "${args.source}". ` +
        `Only "${RACING_API_DISCOVERY_SOURCE_LABEL}" is configured today. ` +
        'Other platforms need real, ToS-compliant adapters before they can be crawled.',
    );
    process.exitCode = 1;
    return;
  }

  // Approval gate for writes — nothing enters the queue from an unvetted feed.
  if (args.commit) {
    const trust = await readSourceTrust(source.sourceLabel);
    const blockers: string[] = [];
    if (!trust.registered) {
      blockers.push(`source "${source.sourceLabel}" is not registered in ${SOURCE_REGISTRY_TABLE}`);
    } else {
      if (!trust.approved) blockers.push(`source "${source.sourceLabel}" is not approved`);
      if (!trust.supportsDiscovery) {
        blockers.push(`source "${source.sourceLabel}" has supports_discovery=false`);
      }
    }
    if (blockers.length > 0) {
      console.error('Refusing to --commit. Resolve these first:');
      for (const b of blockers) console.error(`  - ${b}`);
      console.error(
        '\nRegister + approve via: npm run review:tipster-candidates -- --add-source ... --commit',
      );
      console.error(
        'then approve it, and set supports_discovery=true for the source (see docs/TIPSTER_DISCOVERY_ENGINE.md).',
      );
      process.exitCode = 1;
      return;
    }
  }

  const deps = createDiscoveryDeps((line) => console.log(line));

  let result;
  try {
    result = await runTipsterDiscovery(source, deps, {
      dryRun: !args.commit,
      longWindowDays: args.longWindowDays,
      recentWindowDays: args.recentWindowDays,
    });
  } catch (err) {
    console.error(
      `\nDiscovery failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      'If this mentions RACING_API_*, set RACING_API_USER / RACING_API_KEY in .env.local ' +
        'and confirm with `npm run check:env`.',
    );
    process.exitCode = 1;
    return;
  }

  // Print the captured profiles, strongest first.
  const rows = [...result.rows].sort(
    (a, b) => b.discovery_confidence - a.discovery_confidence,
  );
  const shown = args.limit && args.limit > 0 ? rows.slice(0, args.limit) : rows;

  console.log(
    `\nDiscovered ${result.received} profile(s), ${result.deduped} after dedup` +
      (args.commit
        ? ` — wrote ${result.candidatesNew} new + ${result.candidatesUpdated} updated`
        : ' — DRY RUN (nothing written)') +
      `.\n`,
  );

  console.log(
    'conf  tier                     N      ROI     recROI  strike  placed  recency  tipster',
  );
  console.log(
    '----  -----------------------  -----  ------  ------  ------  ------  -------  ---------------',
  );
  for (const r of shown) {
    const conf = r.discovery_confidence.toFixed(0).padStart(4);
    const tier = r.confidence_tier.padEnd(23);
    const n = numOr(r.sample_size).padStart(5);
    const roi = pct(r.roi).padStart(6);
    const recRoi = pct(r.roi_recent).padStart(6);
    const strike = pct(r.strike_rate).padStart(6);
    const placed = pct(r.placed_rate).padStart(6);
    const recency = (r.recency_days === null ? '—' : `${r.recency_days}d`).padStart(7);
    console.log(
      `${conf}  ${tier}  ${n}  ${roi}  ${recRoi}  ${strike}  ${placed}  ${recency}  ${r.discovered_name}`,
    );
  }

  if (!args.commit) {
    console.log(
      '\nThis was a DRY RUN. Re-run with --commit to capture these into the review tables',
    );
    console.log(
      'for operator review. Captured profiles are ALWAYS pending and never model-active.',
    );
  } else {
    console.log(
      `\n${result.linkedToCanonical} captured profile(s) linked to an existing canonical tipster (link only).`,
    );
    console.log(
      'Review them, then promote chosen profiles to (inactive) canonical tipsters manually.',
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
