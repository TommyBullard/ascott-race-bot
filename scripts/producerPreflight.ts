/**
 * CLI: Producer Readiness Preflight — Nationwide rebuild Phase 7A.2b Step 3.
 *
 * Determines whether it is SAFE to begin an ownership-aware SELECTED-COURSE
 * producer run, WITHOUT starting anything. One verdict — READY / REVIEW /
 * BLOCKED — over twelve checks (see src/lib/producerPreflight.ts).
 *
 * Usage:
 *   npm run producer:preflight -- --date 2026-07-17 --course "Newmarket"
 *   npm run producer:preflight -- --date 2026-07-17 --course "Newmarket" --json
 *   npm run producer:preflight -- --date 2026-07-17 --course "Newmarket" --report
 *   npm run producer:preflight -- --date 2026-07-17 --course "Newmarket" --skip-server
 *   npm run producer:preflight -- --date 2026-07-17 --course "Newmarket" --require-server
 *   npm run producer:preflight -- --date 2026-07-17 --course "Newmarket" --confirm-external
 *
 * READ-ONLY CONTRACT — this command may perform ONLY:
 *   1. the read-only `producer_claim_status` RPC (the ONLY ownership operation
 *      it ever makes — never claim/heartbeat/release);
 *   2. SELECT queries for the stored workload (races/runners/odds/model runs);
 *   3. one optional GET to the FIXED read-only health path
 *      `/api/cron/health?date=` on the validated base origin (bounded timeout,
 *      redirects refused, CRON_SECRET sent as a bearer but never printed);
 *   4. one local Markdown report write, ONLY with --report.
 * It never fetches racecards/odds/results, never runs the model, never starts
 * the pipeline, never spawns a child process, and has NO --commit flag (an
 * explicit `--commit` argument is rejected). SELECTED-COURSE ONLY: the
 * reserved nationwide scope ('all-uk-ire' / 'all uk ire' in any spelling) is
 * explicitly rejected. If the verdict is READY the exact next command is
 * printed as TEXT and deliberately not executed.
 *
 * Exit codes: 0 READY, 3 REVIEW, 2 BLOCKED, 1 usage/flag error.
 * Decision-support only — never places a bet.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeCourse } from '../src/lib/raceSync';
import { isEnvValuePresent } from '../src/lib/envPreflight';
import { fetchProducerClaimStatus } from '../src/lib/producerClaim';
import {
  buildPreflightJson,
  buildProducerPreflightPath,
  evaluateProducerPreflight,
  isReservedNationwideCourse,
  probeHealthEndpoint,
  renderPreflightConsole,
  renderPreflightMarkdown,
  summarizeClaimStatus,
  validateBaseUrl,
  type ClaimStatusSummary,
  type HealthProbeOutcome,
  type PreflightInput,
  type WorkloadSummary,
} from '../src/lib/producerPreflight';

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

interface Args {
  date: string | null;
  course: string | null;
  baseUrl: string;
  skipServer: boolean;
  requireServer: boolean;
  confirmExternal: boolean;
  report: boolean;
  json: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    date: null,
    course: null,
    baseUrl: 'http://localhost:3000',
    skipServer: false,
    requireServer: false,
    confirmExternal: false,
    report: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    switch (flag) {
      case '--date':
        args.date = (next() ?? '').trim();
        break;
      case '--course':
        args.course = (next() ?? '').trim();
        break;
      case '--base-url': {
        const value = (next() ?? '').trim();
        if (value !== '') args.baseUrl = value;
        break;
      }
      case '--skip-server':
        args.skipServer = true;
        break;
      case '--require-server':
        args.requireServer = true;
        break;
      case '--confirm-external':
        args.confirmExternal = true;
        break;
      case '--report':
        args.report = true;
        break;
      case '--json':
        args.json = true;
        break;
      default:
        break;
    }
  }
  return args;
}

/** Usage/flag errors: one JSON object in --json mode, message otherwise. Exit 1. */
function usageError(json: boolean, message: string): void {
  if (json) {
    console.log(JSON.stringify({ read_only: true, ok: false, error: { kind: 'usage', message } }));
  } else {
    console.error(message);
  }
  process.exitCode = 1;
}

/** SELECT-only stored-workload gatherer for one date + course. */
async function gatherWorkload(
  date: string,
  course: string,
): Promise<{ workload: WorkloadSummary | null; error: string | null }> {
  try {
    const { supabaseAdmin } = await import('../src/lib/supabaseAdmin');
    const { data, error } = await supabaseAdmin
      .from('races')
      .select('id, course, off_time, status')
      .eq('meeting_date', date);
    if (error) return { workload: null, error: `races lookup failed: ${error.message}` };
    const want = normalizeCourse(course);
    const races = ((data ?? []) as { id: string | number; course: string | null; off_time: string | null; status: string | null }[])
      .filter((r) => normalizeCourse(r.course) === want)
      .map((r) => ({ ...r, id: String(r.id) }));
    const nowMs = Date.now();
    const settled = races.filter((r) => (r.status ?? '').toLowerCase() === 'result').length;
    const upcoming = races.filter((r) => {
      const ms = r.off_time ? Date.parse(r.off_time) : NaN;
      return Number.isFinite(ms) && ms > nowMs;
    }).length;
    if (races.length === 0) {
      return { workload: { races: 0, runners: 0, racesWithOdds: 0, racesWithModelRuns: 0, settled: 0, upcoming: 0 }, error: null };
    }
    const raceIds = races.map((r) => r.id);
    const [runnersRes, oddsRes, modelRes] = await Promise.all([
      supabaseAdmin.from('runners').select('id', { count: 'exact', head: true }).in('race_id', raceIds),
      supabaseAdmin.from('market_snapshots').select('race_id').in('race_id', raceIds),
      supabaseAdmin.from('model_runs').select('race_id').in('race_id', raceIds),
    ]);
    if (runnersRes.error) return { workload: null, error: `runners lookup failed: ${runnersRes.error.message}` };
    if (oddsRes.error) return { workload: null, error: `snapshots lookup failed: ${oddsRes.error.message}` };
    if (modelRes.error) return { workload: null, error: `model runs lookup failed: ${modelRes.error.message}` };
    const distinct = (rows: unknown): number =>
      new Set(((rows ?? []) as { race_id: string | number }[]).map((r) => String(r.race_id))).size;
    return {
      workload: {
        races: races.length,
        runners: runnersRes.count ?? 0,
        racesWithOdds: distinct(oddsRes.data),
        racesWithModelRuns: distinct(modelRes.data),
        settled,
        upcoming,
      },
      error: null,
    };
  } catch (err) {
    return { workload: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rawArgv = process.argv.slice(2);

  // Read-only contract: no commit/mutation vocabulary is supported at all.
  if (rawArgv.includes('--commit')) {
    usageError(args.json, '--commit is not supported: producer:preflight is READ-ONLY and never executes the pipeline.');
    return;
  }
  if (args.skipServer && args.requireServer) {
    usageError(args.json, '--skip-server and --require-server are mutually exclusive.');
    return;
  }
  if (!args.date) {
    usageError(args.json, 'Usage: npm run producer:preflight -- --date YYYY-MM-DD --course "COURSE" [--base-url URL] [--skip-server|--require-server] [--confirm-external] [--report] [--json]');
    return;
  }
  if (!args.course) {
    usageError(args.json, 'A --course is required: producer:preflight is selected-course only.');
    return;
  }

  loadEnv();

  const env = {
    supabaseUrl: isEnvValuePresent(process.env.SUPABASE_URL),
    serviceRoleKey: isEnvValuePresent(process.env.SUPABASE_SERVICE_ROLE_KEY),
    cronSecret: isEnvValuePresent(process.env.CRON_SECRET),
    projectHost: ((): string | null => {
      try {
        return process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).host : null;
      } catch {
        return null;
      }
    })(),
  };
  const baseUrl = { raw: args.baseUrl, ...validateBaseUrl(args.baseUrl) };
  const inputLooksValid =
    !isReservedNationwideCourse(args.course) && args.course.trim() !== '';

  // 1. Ownership status — the ONLY ownership operation (read-only RPC).
  let claim: ClaimStatusSummary | null = null;
  if (inputLooksValid && env.supabaseUrl && env.serviceRoleKey) {
    claim = summarizeClaimStatus(await fetchProducerClaimStatus(args.date));
  }

  // 2. Stored workload — SELECT-only.
  let workload: WorkloadSummary | null = null;
  let workloadError: string | null = null;
  if (inputLooksValid && env.supabaseUrl && env.serviceRoleKey) {
    const gathered = await gatherWorkload(args.date, args.course);
    workload = gathered.workload;
    workloadError = gathered.error;
  }

  // 3. Optional server probe — the FIXED read-only health path only.
  let server: PreflightInput['server'] = { mode: 'skipped', outcome: null };
  if (!args.skipServer && baseUrl.valid && baseUrl.origin) {
    const outcome: HealthProbeOutcome = await probeHealthEndpoint(
      baseUrl.origin,
      args.date,
      process.env.CRON_SECRET ?? null,
    );
    server = { mode: 'probed', outcome };
  }

  const report = evaluateProducerPreflight({
    date: args.date,
    courseRaw: args.course,
    requireServer: args.requireServer,
    confirmExternal: args.confirmExternal,
    env,
    baseUrl,
    claim,
    workload,
    workloadError,
    server,
  });

  if (args.json) {
    console.log(JSON.stringify(buildPreflightJson(report)));
  } else {
    for (const line of renderPreflightConsole(report)) console.log(line);
  }

  // 4. Local Markdown report — ONLY with --report; otherwise no filesystem write.
  if (args.report) {
    const path = buildProducerPreflightPath(args.date, args.course);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderPreflightMarkdown(report, new Date().toISOString()), 'utf8');
    if (!args.json) console.log(`\nReport written: ${path}`);
  }

  process.exitCode = report.verdict === 'READY' ? 0 : report.verdict === 'REVIEW' ? 3 : 2;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 2;
});
