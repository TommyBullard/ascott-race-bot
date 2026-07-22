/**
 * Nationwide Readiness Preflight — pure evaluation and rendering —
 * Nationwide rebuild Phase 7A.2b Step 5.
 *
 * A SEPARATE command from `producer:preflight` (which remains SELECTED-
 * COURSE-ONLY and continues to reject `all-uk-ire` — untouched by this file).
 * Backs `nationwide:preflight` (scripts/nationwidePreflight.ts): a finite,
 * READ-ONLY verdict — READY / REVIEW / BLOCKED — over whether it is safe to
 * begin a nationwide dry-run for one date.
 *
 * REUSES, NEVER REINVENTS (verified generic by reading producerPreflight.ts):
 * `BaseUrlValidation`/`validateBaseUrl`, `HEALTH_PROBE_TIMEOUT_MS`/
 * `buildHealthProbeUrl`/`probeHealthEndpoint`/`HealthProbeOutcome` (the SAME
 * fixed `/api/cron/health` path — no second probe target), `ClaimStatusSummary`/
 * `summarizeClaimStatus` (date-keyed claim status; scope-agnostic, so it works
 * identically for a nationwide row), and `CheckStatus`/`EvidenceSource`/
 * `PreflightVerdict`/`PreflightCheck` (the same generic check vocabulary).
 * Also reuses {@link ../lib/nationwideDryRun.reconcileNationwideWorkload} —
 * the ONE nationwide rollup rule, shared with the dry-run command itself, so
 * this preflight and the dry-run it gates can never disagree about what
 * "reconciled" means.
 *
 * HONESTY RULE (Correction 2): external conditions (Railway job state, Vercel
 * cron/deployment state, legacy/unclaimed local producers) are NEVER
 * automatically verified. Without `--confirm-external` they stay
 * `unknown`/REVIEW; with it they are labelled `operator_attested` — a human
 * attestation this command recorded, not something it verified itself.
 *
 * The verdict is informational only: it enables, schedules, and invokes
 * nothing. Decision-support only — never places a bet.
 */

import {
  buildHealthProbeUrl,
  HEALTH_PROBE_TIMEOUT_MS,
  probeHealthEndpoint,
  summarizeClaimStatus,
  validateBaseUrl,
  type BaseUrlValidation,
  type CheckStatus,
  type ClaimStatusSummary,
  type EvidenceSource,
  type HealthProbeOutcome,
  type PreflightCheck,
  type PreflightVerdict,
} from './producerPreflight';
import { ALL_UK_IRE_SCOPE } from './producerClaim';
import { reconcileNationwideWorkload, type NationwideReconciliation, type NationwideWorkloadRow } from './nationwideDryRun';

export {
  buildHealthProbeUrl,
  HEALTH_PROBE_TIMEOUT_MS,
  probeHealthEndpoint,
  summarizeClaimStatus,
  validateBaseUrl,
  type BaseUrlValidation,
  type CheckStatus,
  type ClaimStatusSummary,
  type EvidenceSource,
  type HealthProbeOutcome,
  type PreflightCheck,
  type PreflightVerdict,
};

export interface NationwidePreflightInput {
  date: string;
  requireServer: boolean;
  confirmExternal: boolean;
  env: {
    supabaseUrl: boolean;
    serviceRoleKey: boolean;
    cronSecret: boolean;
    projectHost: string | null;
  };
  baseUrl: BaseUrlValidation & { raw: string };
  /** null = not queried (e.g. required configuration missing). */
  claim: ClaimStatusSummary | null;
  /** null = not gathered (read failure). */
  workloadRows: readonly NationwideWorkloadRow[] | null;
  workloadError: string | null;
  server: { mode: 'skipped' | 'probed'; outcome: HealthProbeOutcome | null };
  /**
   * Read-only scan result: slugs of `logs/*​/supervisor.lock` directories
   * found for THIS date (any course) — a concrete, automated signal that a
   * selected-course supervisor MAY be active on this machine. Absence proves
   * nothing about other machines (stays attested/unknown, like Railway/Vercel).
   */
  localLockSlugsForDate: readonly string[];
}

export interface NationwidePreflightReport {
  date: string;
  scope: string;
  verdict: PreflightVerdict;
  checks: PreflightCheck[];
  externalChecksSource: 'operator_attestation' | 'unknown';
  reconciliation: NationwideReconciliation | null;
  suggestedCommand: string | null;
}

/** The exact next-safe-command text (suggestion only — never executed here). Pure. */
export function buildSuggestedNationwideCommand(date: string): string {
  return `npm run nationwide:dry-run -- --date ${date} --mode live-provider`;
}

function skippedCheck(id: string, label: string): PreflightCheck {
  return { id, label, status: 'info', evidence: 'not_applicable', detail: 'skipped — input invalid' };
}

const OPERATOR_ATTESTATION_NOTE =
  'operator attestation only (--confirm-external) — NOT automatically verified by this command';

/**
 * Reduces the gathered evidence to twelve checks and one verdict. Pure and
 * deterministic. BLOCKED beats REVIEW beats READY; `info` checks never
 * affect the verdict.
 */
export function evaluateNationwidePreflight(input: NationwidePreflightInput): NationwidePreflightReport {
  const checks: PreflightCheck[] = [];
  const isValidDate = /^\d{4}-\d{2}-\d{2}$/.test(input.date) && !Number.isNaN(Date.parse(`${input.date}T00:00:00Z`));

  // 1. date
  if (!isValidDate) {
    checks.push({
      id: 'date_scope',
      label: 'date / nationwide scope',
      status: 'blocked',
      evidence: 'automatically_verified',
      detail: `invalid date "${input.date}" — expected strict YYYY-MM-DD`,
    });
  } else {
    checks.push({
      id: 'date_scope',
      label: 'date / nationwide scope',
      status: 'pass',
      evidence: 'automatically_verified',
      detail: `date ${input.date}, scope ${ALL_UK_IRE_SCOPE}`,
    });
  }

  // 2-3. ownership mechanism + active claim (ANY live scope blocks — date-level PK).
  if (!isValidDate) {
    checks.push(skippedCheck('ownership_mechanism', 'ownership mechanism'), skippedCheck('active_claim', 'active claim'));
  } else if (input.claim === null) {
    checks.push(
      { id: 'ownership_mechanism', label: 'ownership mechanism', status: 'blocked', evidence: 'unavailable', detail: 'not queried — required configuration is missing' },
      { id: 'active_claim', label: 'active claim', status: 'blocked', evidence: 'unavailable', detail: 'unknown — the claim status could not be read' },
    );
  } else if (input.claim.kind === 'mechanism_failed') {
    checks.push(
      { id: 'ownership_mechanism', label: 'ownership mechanism', status: 'blocked', evidence: 'unavailable', detail: `status RPC failed (${input.claim.failureKind}): ${input.claim.message}` },
      { id: 'active_claim', label: 'active claim', status: 'blocked', evidence: 'unavailable', detail: 'unknown — the claim status could not be read' },
    );
  } else {
    checks.push({ id: 'ownership_mechanism', label: 'ownership mechanism', status: 'pass', evidence: 'automatically_verified', detail: 'producer_claim_status RPC reachable and well-formed (read-only)' });
    if (input.claim.kind === 'live') {
      checks.push({
        id: 'active_claim',
        label: 'active claim',
        status: 'blocked',
        evidence: 'automatically_verified',
        detail:
          `a LIVE claim exists — owner ${input.claim.ownerPrefix}… scope=${input.claim.scope} generation=${input.claim.generation} ` +
          `expires_at=${input.claim.expiresAt} (${input.claim.remainingSeconds ?? '?'}s remaining). A nationwide claim conflicts with ` +
          'EVERY scope for this date (course or nationwide) — do not start another producer.',
      });
    } else if (input.claim.kind === 'expired') {
      checks.push({
        id: 'active_claim',
        label: 'active claim',
        status: 'review',
        evidence: 'automatically_verified',
        detail:
          `an EXPIRED claim exists — owner ${input.claim.ownerPrefix}… scope=${input.claim.scope} generation=${input.claim.generation} ` +
          `(expired ${input.claim.expiredSeconds ?? '?'}s ago). It is stealable, but this preflight did NOT steal it and never will.`,
      });
    } else if (input.claim.kind === 'unknown_liveness') {
      checks.push({ id: 'active_claim', label: 'active claim', status: 'blocked', evidence: 'unavailable', detail: 'claim liveness could not be established from server time — fail-closed' });
    } else {
      checks.push({ id: 'active_claim', label: 'active claim', status: 'pass', evidence: 'automatically_verified', detail: 'no claim exists for this date (unclaimed)' });
    }
  }

  // 4-6. stored workload / odds coverage / rollup reconciliation / country warnings.
  let reconciliation: NationwideReconciliation | null = null;
  if (!isValidDate) {
    checks.push(
      skippedCheck('stored_workload', 'stored nationwide workload'),
      skippedCheck('odds_coverage', 'odds coverage'),
      skippedCheck('rollup_reconciliation', 'rollup reconciliation'),
      skippedCheck('country_region_warnings', 'country / region warnings'),
    );
  } else if (input.workloadRows === null) {
    const why = input.workloadError ?? 'not gathered';
    checks.push(
      { id: 'stored_workload', label: 'stored nationwide workload', status: 'review', evidence: 'unavailable', detail: `could not be read (${why})` },
      { id: 'odds_coverage', label: 'odds coverage', status: 'info', evidence: 'unavailable', detail: 'unknown' },
      { id: 'rollup_reconciliation', label: 'rollup reconciliation', status: 'info', evidence: 'unavailable', detail: 'unknown' },
      { id: 'country_region_warnings', label: 'country / region warnings', status: 'info', evidence: 'unavailable', detail: 'unknown' },
    );
  } else {
    reconciliation = reconcileNationwideWorkload(input.workloadRows);
    const t = reconciliation.totals;
    if (t.races === 0 || t.courses === 0) {
      checks.push({
        id: 'stored_workload',
        label: 'stored nationwide workload',
        status: 'review',
        evidence: 'automatically_verified',
        detail: `ZERO stored races/courses for this date — racecards have not been ingested yet (never fetched by this command)`,
      });
      checks.push(
        { id: 'odds_coverage', label: 'odds coverage', status: 'info', evidence: 'not_applicable', detail: 'no stored races' },
        { id: 'rollup_reconciliation', label: 'rollup reconciliation', status: 'info', evidence: 'not_applicable', detail: 'no stored races' },
        { id: 'country_region_warnings', label: 'country / region warnings', status: 'info', evidence: 'not_applicable', detail: 'no stored races' },
      );
    } else {
      checks.push({
        id: 'stored_workload',
        label: 'stored nationwide workload',
        status: 'pass',
        evidence: 'automatically_verified',
        detail: `${t.courses} course(s), ${t.races} race(s), ${t.runners} runner(s)`,
      });
      checks.push({
        id: 'odds_coverage',
        label: 'odds coverage',
        status: t.races_with_odds === 0 ? 'review' : 'pass',
        evidence: 'automatically_verified',
        detail: `${t.races_with_odds}/${t.races} races have stored odds; ${t.priced_runners}/${t.runners} runners priced`,
      });
      checks.push({
        id: 'rollup_reconciliation',
        label: 'rollup reconciliation',
        status: reconciliation.violations.length > 0 ? 'blocked' : 'pass',
        evidence: 'automatically_verified',
        detail:
          reconciliation.violations.length > 0
            ? `${reconciliation.violations.length} invariant violation(s): ${reconciliation.violations.join('; ')}`
            : 'per-course sums reconcile to the nationwide totals; no invariant violations',
      });
      checks.push({
        id: 'country_region_warnings',
        label: 'country / region warnings',
        status: reconciliation.warnings.length > 0 ? 'review' : 'pass',
        evidence: 'automatically_verified',
        detail: reconciliation.warnings.length > 0 ? reconciliation.warnings.join('; ') : 'no course-label or country warnings',
      });
    }
  }

  // 7. required configuration.
  {
    const missing: string[] = [];
    if (!input.env.supabaseUrl) missing.push('SUPABASE_URL');
    if (!input.env.serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
    if (!input.env.cronSecret) missing.push('CRON_SECRET');
    checks.push(
      missing.length > 0
        ? {
            id: 'required_configuration',
            label: 'required configuration',
            status: 'blocked',
            evidence: 'automatically_verified',
            detail: `missing (by NAME only — values are never read into output): ${missing.join(', ')}`,
          }
        : {
            id: 'required_configuration',
            label: 'required configuration',
            status: 'pass',
            evidence: 'automatically_verified',
            detail:
              'SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET present (presence only — no values)' +
              (input.env.projectHost ? `; Supabase project host: ${input.env.projectHost}` : ''),
          },
    );
  }

  // 8. server reachability (the SAME fixed health probe as producer:preflight).
  if (!input.baseUrl.valid) {
    checks.push({ id: 'server_reachability', label: 'server reachability', status: 'blocked', evidence: 'automatically_verified', detail: `base URL "${input.baseUrl.raw}" is invalid: ${input.baseUrl.reason}` });
  } else if (input.server.mode === 'skipped' || input.server.outcome === null) {
    checks.push({ id: 'server_reachability', label: 'server reachability', status: 'review', evidence: 'unknown', detail: 'not probed (--skip-server) — confirm the server yourself before a live-provider run' });
  } else {
    const o = input.server.outcome;
    if (o.result === 'ok') {
      checks.push({ id: 'server_reachability', label: 'server reachability', status: 'pass', evidence: 'automatically_verified', detail: o.detail });
    } else if (o.result === 'wrong_app' || o.result === 'redirect_refused') {
      checks.push({ id: 'server_reachability', label: 'server reachability', status: 'blocked', evidence: 'automatically_verified', detail: `${o.detail} — a reachable endpoint that is not verifiably this app blocks a run` });
    } else {
      const blocked = input.requireServer;
      checks.push({ id: 'server_reachability', label: 'server reachability', status: blocked ? 'blocked' : 'review', evidence: 'automatically_verified', detail: o.detail + (blocked ? ' (--require-server: this blocks the run)' : '') });
    }
  }

  // 9. local supervisor.lock signals — presence is strong automated evidence; absence stays attested/unknown.
  if (input.localLockSlugsForDate.length > 0) {
    checks.push({
      id: 'local_supervisor_locks',
      label: 'local supervisor locks',
      status: 'review',
      evidence: 'automatically_verified',
      detail: `found local supervisor.lock director${input.localLockSlugsForDate.length === 1 ? 'y' : 'ies'} for this date: ${input.localLockSlugsForDate.join(', ')} — a selected-course supervisor may be active on this machine`,
    });
  } else {
    checks.push({
      id: 'local_supervisor_locks',
      label: 'local supervisor locks',
      status: input.confirmExternal ? 'pass' : 'review',
      evidence: input.confirmExternal ? 'operator_attested' : 'unknown',
      detail: input.confirmExternal
        ? `no local supervisor.lock found for this date, and no other-machine producer known to be active — ${OPERATOR_ATTESTATION_NOTE}`
        : 'no local supervisor.lock found on THIS machine for this date — proves nothing about other machines; MANUAL check',
    });
  }

  // 10-11. Railway / Vercel — NEVER automatically verified.
  const externalStatus: CheckStatus = input.confirmExternal ? 'pass' : 'review';
  const externalEvidence: EvidenceSource = input.confirmExternal ? 'operator_attested' : 'unknown';
  checks.push(
    {
      id: 'railway_job_state',
      label: 'Railway job state',
      status: externalStatus,
      evidence: externalEvidence,
      detail: input.confirmExternal
        ? `Railway pipeline-refresh / selected-course jobs quiescent for this date — ${OPERATOR_ATTESTATION_NOTE}`
        : 'UNKNOWN — Railway cron configuration lives in the Railway dashboard and cannot be proven from this repository; MANUAL check',
    },
    {
      id: 'vercel_cron_state',
      label: 'Vercel cron state',
      status: externalStatus,
      evidence: externalEvidence,
      detail: input.confirmExternal
        ? `no live Vercel deployment firing vercel.json crons — ${OPERATOR_ATTESTATION_NOTE}`
        : 'UNKNOWN — vercel.json declares odds/model/results crons, but whether a Vercel deployment is live cannot be proven from this repository; MANUAL check',
    },
  );

  // 12. bypass entry points (static; informational; never affects the verdict).
  checks.push({
    id: 'bypass_entry_points',
    label: 'bypass entry points',
    status: 'info',
    evidence: 'automatically_verified',
    detail:
      'gated by this preflight: nationwide:dry-run only. Still able to bypass ANY producer claim (operational ' +
      'restrictions — do not use while a nationwide claim is held): direct CRON_SECRET calls to ' +
      '/api/cron/racecards|odds|model|results, POST /api/run-model, run:model, model:day, and any selected-course ' +
      'pipeline:day/pipeline:watch launch for this date (it will be refused by the claim, but its attempt still costs an RPC).',
  });

  const verdict: PreflightVerdict = checks.some((c) => c.status === 'blocked')
    ? 'BLOCKED'
    : checks.some((c) => c.status === 'review')
      ? 'REVIEW'
      : 'READY';

  return {
    date: input.date,
    scope: ALL_UK_IRE_SCOPE,
    verdict,
    checks,
    externalChecksSource: input.confirmExternal ? 'operator_attestation' : 'unknown',
    reconciliation,
    suggestedCommand: verdict === 'READY' ? buildSuggestedNationwideCommand(input.date) : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Rendering (console / JSON / Markdown) — deterministic, secret-free         */
/* -------------------------------------------------------------------------- */

const STATUS_TAG: Record<CheckStatus, string> = {
  pass: '[PASS]   ',
  review: '[REVIEW] ',
  blocked: '[BLOCKED]',
  info: '[INFO]   ',
};

export function renderNationwidePreflightConsole(report: NationwidePreflightReport): string[] {
  const lines: string[] = [];
  lines.push(`Nationwide readiness — ${report.date} — scope ${report.scope}`);
  lines.push('READ ONLY — status inspection only; no claim acquired, no provider/scoring work, nothing executed.');
  lines.push('');
  lines.push(`Verdict: ${report.verdict}`);
  lines.push(
    `External checks source: ${report.externalChecksSource === 'operator_attestation' ? 'operator_attestation (NOT automatically verified)' : 'unknown (manual checks outstanding)'}`,
  );
  lines.push('');
  lines.push('Checks:');
  for (const c of report.checks) lines.push(`  ${STATUS_TAG[c.status]} ${c.label} — ${c.detail} [${c.evidence}]`);
  lines.push('');
  if (report.verdict === 'READY') {
    lines.push('Operator actions:');
    lines.push('  Next safe command (suggestion only — NOT executed by this preflight):');
    lines.push(`    ${report.suggestedCommand}`);
  } else if (report.verdict === 'REVIEW') {
    lines.push('Operator actions — manual checks required before a nationwide run:');
    for (const c of report.checks.filter((c) => c.status === 'review')) lines.push(`  - ${c.label}: ${c.detail}`);
  } else {
    lines.push('Operator actions — NO nationwide run should start:');
    for (const c of report.checks.filter((c) => c.status === 'blocked')) lines.push(`  - ${c.label}: ${c.detail}`);
  }
  return lines;
}

export function buildNationwidePreflightJson(report: NationwidePreflightReport): Record<string, unknown> {
  return {
    read_only: true,
    date: report.date,
    scope: report.scope,
    verdict: report.verdict,
    external_checks_source: report.externalChecksSource,
    checks: report.checks.map((c) => ({ id: c.id, label: c.label, status: c.status, evidence: c.evidence, detail: c.detail })),
    suggested_next_command: report.suggestedCommand,
    suggested_command_executed: false,
    nationwide_execution: 'disabled',
  };
}

export function renderNationwidePreflightMarkdown(report: NationwidePreflightReport, generatedAtIso: string): string {
  const lines: string[] = [];
  lines.push(`# Nationwide readiness preflight — ${report.date}`);
  lines.push('');
  lines.push(`Generated: ${generatedAtIso}`);
  lines.push('');
  lines.push('**READ ONLY.** No provider or scoring work was started. No ownership claim was');
  lines.push('acquired (status inspection only). Nationwide execution remains disabled.');
  lines.push('External producer checks (Railway / Vercel / other-machine producers) are');
  lines.push('manual/operator-attested unless proven — this command did not verify them.');
  lines.push('');
  lines.push(`## Verdict: ${report.verdict}`);
  lines.push('');
  lines.push(`External checks source: \`${report.externalChecksSource}\``);
  lines.push('');
  lines.push('| Check | Status | Evidence | Detail |');
  lines.push('| --- | --- | --- | --- |');
  for (const c of report.checks) lines.push(`| ${c.label} | ${c.status.toUpperCase()} | ${c.evidence} | ${c.detail.replace(/\|/g, '\\|')} |`);
  lines.push('');
  if (report.verdict === 'READY' && report.suggestedCommand) {
    lines.push('## Next safe command (suggestion only — not executed)');
    lines.push('');
    lines.push('```');
    lines.push(report.suggestedCommand);
    lines.push('```');
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  lines.push('Decision-support only — no betting, no bet placement.');
  lines.push('');
  return lines.join('\n');
}

/** Report path: reports/nationwide-preflight-<date>.md. Pure. */
export function buildNationwidePreflightPath(date: string): string {
  return `reports/nationwide-preflight-${date}.md`;
}
