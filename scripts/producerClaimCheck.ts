/**
 * CLI: producer ownership claim diagnostic tool — Nationwide rebuild
 * Phase 7A.2b Step 1.
 *
 * Lets an operator inspect and (explicitly) exercise the day-level producer
 * ownership claim (`producer_run_claims` — see the migration
 * 20260711000000_producer_run_claims.sql and `src/lib/producerClaim.ts`)
 * WITHOUT running any part of the actual producer.
 *
 * Usage:
 *   npm run producer:claim-check -- --date 2026-07-11
 *   npm run producer:claim-check -- --date 2026-07-11 --op status
 *   npm run producer:claim-check -- --date 2026-07-11 --op claim --scope all-uk-ire --owner-id my-id
 *   npm run producer:claim-check -- --date 2026-07-11 --op claim --scope course:Newmarket --owner-id my-id
 *   npm run producer:claim-check -- --date 2026-07-11 --op heartbeat --owner-id my-id
 *   npm run producer:claim-check -- --date 2026-07-11 --op release --owner-id my-id
 *
 * `--op` defaults to `status`, which is READ-ONLY (a plain SELECT). `claim`,
 * `heartbeat`, and `release` MUTATE the claim table and each require an
 * EXPLICIT `--owner-id` — there is no default/auto-generated owner for a
 * mutating op, so there is never ambiguity about who is acting. There is NO
 * `--commit` flag anywhere in this tool; the four op names are the explicit,
 * unambiguous vocabulary, deliberately distinct from race-data commit mode.
 *
 * THIS TOOL NEVER CALLS: the Racing API, Betfair, the model
 * (`runModelForRace` / `scoreRaceRunners`), `lock:t-minus`, `results:auto`,
 * `pipeline:day`, or `pipeline:watch`. Its ONLY database surface is the three
 * `producer_run_claims` RPCs (`try_acquire_producer_claim` /
 * `heartbeat_producer_claim` / `release_producer_claim`) plus a single
 * read-only SELECT for status. Nothing here enables, schedules, or invokes
 * nationwide processing. Decision-support only — not betting advice.
 */

import {
  PRODUCER_CLAIM_DEFAULT_TTL_SECONDS,
  fetchProducerClaimStatus,
  heartbeatProducerClaim,
  isValidRaceDate,
  isValidScope,
  normalizeScopeInput,
  releaseProducerClaim,
  tryAcquireProducerClaim,
  type ClaimFailure,
} from '../src/lib/producerClaim';

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

type Op = 'status' | 'claim' | 'heartbeat' | 'release';
const VALID_OPS: readonly Op[] = ['status', 'claim', 'heartbeat', 'release'];

interface Args {
  date: string | null;
  scope: string | null;
  op: Op;
  ownerId: string | null;
  ttlSeconds: number | null;
  hostname: string | null;
  pid: number | null;
  appVersion: string | null;
  mode: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    date: null,
    scope: null,
    op: 'status',
    ownerId: null,
    ttlSeconds: null,
    hostname: null,
    pid: null,
    appVersion: null,
    mode: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    switch (flag) {
      case '--date':
        args.date = (next() ?? '').trim();
        break;
      case '--scope':
        args.scope = (next() ?? '').trim();
        break;
      case '--op': {
        const value = (next() ?? '').trim();
        if ((VALID_OPS as readonly string[]).includes(value)) args.op = value as Op;
        break;
      }
      case '--owner-id':
        args.ownerId = (next() ?? '').trim();
        break;
      case '--ttl-seconds': {
        const value = Number(next());
        if (Number.isFinite(value) && value > 0) args.ttlSeconds = value;
        break;
      }
      case '--hostname':
        args.hostname = next() ?? null;
        break;
      case '--pid': {
        const value = Number(next());
        if (Number.isFinite(value)) args.pid = value;
        break;
      }
      case '--app-version':
        args.appVersion = next() ?? null;
        break;
      case '--mode':
        args.mode = next() ?? null;
        break;
      default:
        break;
    }
  }
  return args;
}

function usage(): void {
  console.error(
    [
      'Usage: npm run producer:claim-check -- --date YYYY-MM-DD [--op status|claim|heartbeat|release]',
      '         [--scope all-uk-ire|course:<name>] [--owner-id <id>] [--ttl-seconds N]',
      '         [--hostname X] [--pid N] [--app-version X] [--mode X]',
      '',
      '  status    (default) READ-ONLY — shows the current claim for the date, or "unclaimed".',
      '  claim     MUTATES — requires --scope and --owner-id.',
      '  heartbeat MUTATES — requires --owner-id.',
      '  release   MUTATES — requires --owner-id.',
      '',
      'There is no --commit flag. This tool never calls the Racing API, Betfair,',
      'the model, lock:t-minus, results:auto, pipeline:day, or pipeline:watch.',
    ].join('\n'),
  );
}

function printFailure(prefix: string, failure: ClaimFailure): void {
  console.error(`${prefix}: [${failure.kind}] ${failure.message}`);
}

async function main(): Promise<void> {
  loadEnv();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local (or .env).');
    process.exitCode = 1;
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  if (!args.date || !isValidRaceDate(args.date)) {
    usage();
    process.exitCode = 1;
    return;
  }

  console.log(`producer:claim-check — date ${args.date} — op ${args.op}`);

  if (args.op === 'status') {
    const result = await fetchProducerClaimStatus(args.date);
    if (!result.ok) {
      printFailure('status FAILED', result.failure);
      process.exitCode = 2;
      return;
    }
    if (!result.claim) {
      console.log('unclaimed — no producer currently owns this date.');
      return;
    }
    const c = result.claim;
    console.log(
      `claimed — scope=${c.scope} owner=${c.ownerId} claimed_at=${c.claimedAt} heartbeat_at=${c.heartbeatAt} expires_at=${c.expiresAt}` +
        (c.hostname ? ` hostname=${c.hostname}` : '') +
        (c.pid !== null ? ` pid=${c.pid}` : '') +
        (c.appVersion ? ` app_version=${c.appVersion}` : '') +
        (c.mode ? ` mode=${c.mode}` : ''),
    );
    return;
  }

  if (args.op === 'claim') {
    const normalizedScope = args.scope ? normalizeScopeInput(args.scope) : null;
    if (!normalizedScope || !isValidScope(normalizedScope)) {
      console.error(`claim requires a valid --scope (got: ${args.scope ?? '(none)'}). Example: all-uk-ire or course:Newmarket`);
      process.exitCode = 1;
      return;
    }
    if (!args.ownerId) {
      console.error('claim requires an explicit --owner-id.');
      process.exitCode = 1;
      return;
    }
    const result = await tryAcquireProducerClaim({
      raceDate: args.date,
      scope: normalizedScope,
      ownerId: args.ownerId,
      ttlSeconds: args.ttlSeconds ?? PRODUCER_CLAIM_DEFAULT_TTL_SECONDS,
      hostname: args.hostname,
      pid: args.pid,
      appVersion: args.appVersion,
      mode: args.mode,
    });
    if (!result.ok) {
      printFailure('claim FAILED (fail-closed)', result.failure);
      process.exitCode = 2;
      return;
    }
    if (result.acquired) {
      console.log(
        `ACQUIRED${result.stoleExpired ? ' (stole an expired claim)' : ''} — owner=${args.ownerId} scope=${normalizedScope} expires_at=${result.currentExpiresAt}`,
      );
    } else {
      console.log(
        `REFUSED — a live claim is already held by owner=${result.currentOwnerId} scope=${result.currentScope} expires_at=${result.currentExpiresAt}`,
      );
      process.exitCode = 3;
    }
    return;
  }

  if (args.op === 'heartbeat') {
    if (!args.ownerId) {
      console.error('heartbeat requires an explicit --owner-id.');
      process.exitCode = 1;
      return;
    }
    const result = await heartbeatProducerClaim({
      raceDate: args.date,
      ownerId: args.ownerId,
      ttlSeconds: args.ttlSeconds ?? PRODUCER_CLAIM_DEFAULT_TTL_SECONDS,
    });
    if (!result.ok) {
      printFailure('heartbeat FAILED (fail-closed / uncertain)', result.failure);
      process.exitCode = 2;
      return;
    }
    if (result.renewed) {
      console.log(`RENEWED — owner=${args.ownerId} expires_at=${result.expiresAt}`);
    } else {
      console.log(`NOT RENEWED — owner=${args.ownerId} does not currently hold this date (confirmed ownership loss).`);
      process.exitCode = 3;
    }
    return;
  }

  // args.op === 'release'
  if (!args.ownerId) {
    console.error('release requires an explicit --owner-id.');
    process.exitCode = 1;
    return;
  }
  const result = await releaseProducerClaim({ raceDate: args.date, ownerId: args.ownerId });
  if (!result.ok) {
    printFailure('release FAILED (fail-closed)', result.failure);
    process.exitCode = 2;
    return;
  }
  console.log(result.released ? `RELEASED — owner=${args.ownerId}` : `NOT RELEASED — owner=${args.ownerId} did not hold this date.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 2;
});
