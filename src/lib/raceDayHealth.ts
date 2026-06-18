/**
 * Race-day health & freshness engine — pure monitoring core (Phase 5).
 *
 * Turns the always-available freshness signals (the meeting's race off-times +
 * statuses, the latest odds snapshot time, the latest model-run time) plus the
 * optional cron heartbeat (last OK/FAIL per job) into a per-stage health verdict,
 * an overall system status, and the single most useful operator action.
 *
 * It is the backbone of the self-updating system's MONITORING + HEALTH DASHBOARD,
 * and it is strictly decision-support:
 *   - PURE. No I/O, no DB, no network. Deterministic given its inputs (`now` is
 *     injected), so it is fully unit-testable. The caller gathers the inputs
 *     SELECT-only and renders/serves the output.
 *   - READ-ONLY POSTURE. It never runs a job, writes a row, or places a bet. It
 *     only classifies freshness and SUGGESTS what an operator should look at.
 *   - HONEST. Missing signals classify as STALLED/UNKNOWN, never FRESH; nothing
 *     is fabricated.
 */

/** The automated pipeline stages this engine tracks. */
export type HealthStage = 'racecards' | 'odds' | 'model' | 'results';

/** A cron job that may report a heartbeat. */
export type CronJob = 'racecards' | 'odds' | 'model' | 'results' | 'tipster-discovery' | 'training-capture';

/** Freshness verdict for one stage. */
export type StageStatus = 'FRESH' | 'STALE' | 'STALLED' | 'IDLE' | 'PENDING';

/** Overall system status (worst active stage). */
export type SystemStatus = 'HEALTHY' | 'DEGRADED' | 'STALLED' | 'IDLE';

/** The meeting phase relative to the racing window. */
export type RacePhase = 'no_races' | 'pre' | 'racing' | 'post';

// --- Cadence + staleness thresholds (ms; exported so docs/tests stay in sync) ---

const MIN = 60_000;
/** Odds/model crons run every 5 min during racing. */
export const REFRESH_CADENCE_MS = 5 * MIN;
/** Odds older than this (during racing) is STALE. */
export const ODDS_STALE_MS = 12 * MIN;
/** Odds older than this (during racing) is STALLED. */
export const ODDS_STALLED_MS = 20 * MIN;
/** Model older than this (during racing) is STALE. */
export const MODEL_STALE_MS = 12 * MIN;
/** Model older than this (during racing) is STALLED. */
export const MODEL_STALLED_MS = 20 * MIN;
/** Model trailing the latest odds by more than this reads as "lagging". */
export const MODEL_LAG_MS = 10 * MIN;
/** Lead time before the first off when odds/model are expected to be live. */
export const PRE_RACING_LEAD_MS = 60 * MIN;
/** A started race unsettled longer than this expects a result. */
export const RESULT_GRACE_MS = 25 * MIN;
/** A started race unsettled longer than this is a STALLED settlement. */
export const RESULT_STALLED_MS = 45 * MIN;

/** One race's timing + lifecycle, the only race fields this engine needs. */
export interface HealthRace {
  /** Scheduled off time (epoch ms), or null when unknown. */
  offTimeMs: number | null;
  /** Stored race status (e.g. 'scheduled' | 'result'), or null. */
  status: string | null;
}

/** Inputs for {@link assessRaceDayHealth}. All gathered SELECT-only. */
export interface HealthInput {
  now: Date;
  /** The meeting's races (off time + status). */
  races: readonly HealthRace[];
  /** Latest odds snapshot time across the meeting (epoch ms), or null. */
  latestOddsMs: number | null;
  /** Latest model-run time across the meeting (epoch ms), or null. */
  latestModelMs: number | null;
  /** Last SUCCESSFUL cron run per job (epoch ms) — optional heartbeat enrichment. */
  lastCronOkMs?: Partial<Record<CronJob, number>>;
  /** Last FAILED cron run per job (epoch ms) — optional heartbeat enrichment. */
  lastCronFailMs?: Partial<Record<CronJob, number>>;
}

/** Per-stage health detail. */
export interface StageHealth {
  stage: HealthStage;
  status: StageStatus;
  /** Age of the relevant signal in ms, or null when there is no signal. */
  ageMs: number | null;
  /** Expected refresh cadence in ms (for the dashboard "every Nm"). */
  expectedEveryMs: number | null;
  /** Short human detail. */
  detail: string;
}

/** Operator action tone, matching the existing widgets. */
export type HealthTone = 'pos' | 'warn' | 'neutral';

/** The full health read-model for a meeting. */
export interface RaceDayHealth {
  phase: RacePhase;
  systemStatus: SystemStatus;
  stages: StageHealth[];
  /** The single most useful thing for the operator to look at now. */
  action: { headline: string; detail: string; tone: HealthTone };
  /** Counts for the dashboard header. */
  counts: { total: number; settled: number; upcoming: number; awaitingResult: number };
}

/** A finite number, else null. */
function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Classifies an age against stale/stalled thresholds (null age → STALLED). */
function freshnessOf(ageMs: number | null, staleMs: number, stalledMs: number): StageStatus {
  if (ageMs === null) return 'STALLED';
  if (ageMs <= staleMs) return 'FRESH';
  if (ageMs <= stalledMs) return 'STALE';
  return 'STALLED';
}

/** Whole minutes (rounded) for detail text. */
function mins(ageMs: number | null): string {
  return ageMs === null ? 'never' : `${Math.round(ageMs / MIN)}m`;
}

/** Derives the meeting phase from the races + now. */
function derivePhase(races: readonly HealthRace[], nowMs: number): RacePhase {
  if (races.length === 0) return 'no_races';
  const settled = races.filter((r) => (r.status ?? '') === 'result').length;
  if (settled === races.length) return 'post';
  const offs = races.map((r) => num(r.offTimeMs)).filter((v): v is number => v !== null);
  const firstOff = offs.length > 0 ? Math.min(...offs) : null;
  if (firstOff !== null && nowMs < firstOff - PRE_RACING_LEAD_MS) return 'pre';
  return 'racing';
}

/** Worst-of reducer for the overall status. */
function worst(statuses: StageStatus[]): SystemStatus {
  if (statuses.includes('STALLED')) return 'STALLED';
  if (statuses.includes('STALE')) return 'DEGRADED';
  if (statuses.some((s) => s === 'FRESH')) return 'HEALTHY';
  return 'IDLE';
}

/**
 * Assesses race-day health: per-stage freshness, the overall system status, and
 * the operator's next action. Pure & deterministic.
 *
 * Stages are only held to their cadence while the meeting is RACING (or within
 * the pre-racing lead); outside that window they read IDLE/PENDING rather than
 * raising false alarms. Missing signals during racing are STALLED, never FRESH —
 * a dead cron is surfaced, not hidden.
 */
export function assessRaceDayHealth(input: HealthInput): RaceDayHealth {
  const nowMs = input.now.getTime();
  const { races } = input;
  const phase = derivePhase(races, nowMs);

  const settled = races.filter((r) => (r.status ?? '') === 'result').length;
  const upcoming = races.filter(
    (r) => (r.status ?? '') !== 'result' && num(r.offTimeMs) !== null && (num(r.offTimeMs) as number) > nowMs,
  ).length;
  // Started but not settled (awaiting a result).
  const awaiting = races.filter(
    (r) => (r.status ?? '') !== 'result' && num(r.offTimeMs) !== null && (num(r.offTimeMs) as number) <= nowMs,
  );
  const counts = { total: races.length, settled, upcoming, awaitingResult: awaiting.length };

  const live = phase === 'racing';

  // --- racecards: cards must exist before racing. ---------------------------
  const cardsStage: StageHealth = ((): StageHealth => {
    if (races.length > 0) {
      return { stage: 'racecards', status: 'FRESH', ageMs: null, expectedEveryMs: null, detail: `${races.length} race(s) loaded` };
    }
    if (phase === 'pre' || phase === 'racing') {
      return { stage: 'racecards', status: 'STALLED', ageMs: null, expectedEveryMs: null, detail: 'no racecards loaded for the meeting' };
    }
    return { stage: 'racecards', status: 'IDLE', ageMs: null, expectedEveryMs: null, detail: 'no meeting' };
  })();

  // --- odds: every 5 min during racing. ------------------------------------
  const oddsAge = num(input.latestOddsMs) === null ? null : nowMs - (input.latestOddsMs as number);
  const oddsStage: StageHealth = live
    ? {
        stage: 'odds',
        status: freshnessOf(oddsAge, ODDS_STALE_MS, ODDS_STALLED_MS),
        ageMs: oddsAge,
        expectedEveryMs: REFRESH_CADENCE_MS,
        detail: `odds last refreshed ${mins(oddsAge)} ago`,
      }
    : { stage: 'odds', status: 'IDLE', ageMs: oddsAge, expectedEveryMs: REFRESH_CADENCE_MS, detail: phase === 'pre' ? 'pre-racing' : 'outside racing window' };

  // --- model: every 5 min during racing; must not lag the odds. ------------
  const modelAge = num(input.latestModelMs) === null ? null : nowMs - (input.latestModelMs as number);
  const modelStage: StageHealth = ((): StageHealth => {
    if (!live) {
      return { stage: 'model', status: 'IDLE', ageMs: modelAge, expectedEveryMs: REFRESH_CADENCE_MS, detail: phase === 'pre' ? 'pre-racing' : 'outside racing window' };
    }
    let status = freshnessOf(modelAge, MODEL_STALE_MS, MODEL_STALLED_MS);
    let detail = `model last ran ${mins(modelAge)} ago`;
    // Model lagging the odds (fresh odds, stale-relative model) is a degraded signal.
    if (status === 'FRESH' && oddsAge !== null && modelAge !== null && modelAge - oddsAge > MODEL_LAG_MS) {
      status = 'STALE';
      detail = `model is ${mins(modelAge - oddsAge)} behind the latest odds`;
    }
    return { stage: 'model', status, ageMs: modelAge, expectedEveryMs: REFRESH_CADENCE_MS, detail };
  })();

  // --- results: settlement of started races. -------------------------------
  const oldestAwaitingAge = awaiting.reduce<number | null>((max, r) => {
    const off = num(r.offTimeMs);
    if (off === null) return max;
    const age = nowMs - off;
    return max === null || age > max ? age : max;
  }, null);
  const resultsStage: StageHealth = ((): StageHealth => {
    if (oldestAwaitingAge === null) {
      const allDone = races.length > 0 && settled === races.length;
      return { stage: 'results', status: allDone ? 'FRESH' : 'PENDING', ageMs: null, expectedEveryMs: REFRESH_CADENCE_MS, detail: allDone ? 'all races settled' : 'no race awaiting a result' };
    }
    const status = freshnessOf(oldestAwaitingAge, RESULT_GRACE_MS, RESULT_STALLED_MS);
    return {
      stage: 'results',
      status,
      ageMs: oldestAwaitingAge,
      expectedEveryMs: REFRESH_CADENCE_MS,
      detail:
        status === 'FRESH'
          ? `awaiting result (${mins(oldestAwaitingAge)} since off)`
          : `result overdue — ${mins(oldestAwaitingAge)} since off, still unsettled`,
    };
  })();

  const stages = [cardsStage, oddsStage, modelStage, resultsStage];
  const activeStatuses = stages.filter((s) => s.status !== 'IDLE' && s.status !== 'PENDING').map((s) => s.status);
  const systemStatus: SystemStatus =
    phase === 'no_races'
      ? 'IDLE'
      : worst(activeStatuses.length ? activeStatuses : (['IDLE'] as StageStatus[]));

  return {
    phase,
    systemStatus,
    stages,
    action: deriveAction(phase, stages, counts, input),
    counts,
  };
}

/** Derives the single most useful operator action (worst problem first). Pure. */
function deriveAction(
  phase: RacePhase,
  stages: StageHealth[],
  counts: RaceDayHealth['counts'],
  input: HealthInput,
): RaceDayHealth['action'] {
  const byStage = (s: HealthStage) => stages.find((x) => x.stage === s)!;
  const failHint = (job: CronJob): string => {
    const failMs = input.lastCronFailMs?.[job];
    const okMs = input.lastCronOkMs?.[job];
    if (failMs != null && (okMs == null || failMs > okMs)) return ` (last ${job} cron FAILED)`;
    return '';
  };

  // STALLED problems first.
  if (byStage('racecards').status === 'STALLED') {
    return { headline: 'No racecards loaded', detail: `Run / check the racecards cron${failHint('racecards')}.`, tone: 'warn' };
  }
  if (byStage('results').status === 'STALLED') {
    return {
      headline: 'Settlement overdue',
      detail: `A race is well past off and unsettled — check the results cron or import results${failHint('results')}.`,
      tone: 'warn',
    };
  }
  if (byStage('odds').status === 'STALLED') {
    return { headline: 'Odds refresh stalled', detail: `Odds are stale — check the odds cron / Betfair credentials${failHint('odds')}.`, tone: 'warn' };
  }
  if (byStage('model').status === 'STALLED') {
    return { headline: 'Model refresh stalled', detail: `The model has not re-scored recently — check the model/results cron${failHint('model')}.`, tone: 'warn' };
  }
  // STALE next.
  const stale = stages.find((s) => s.status === 'STALE');
  if (stale) {
    return { headline: `${stale.stage} degraded`, detail: stale.detail, tone: 'warn' };
  }
  // Healthy / phase-based.
  if (phase === 'no_races') return { headline: 'No meeting loaded', detail: 'Load a racecard to begin.', tone: 'neutral' };
  if (phase === 'pre') return { headline: 'Pre-racing — systems idle', detail: 'Cards loaded; odds/model go live near the first off. Monitor.', tone: 'neutral' };
  if (phase === 'post') return { headline: 'All races settled', detail: 'Run end-of-day reports / audits.', tone: 'pos' };
  return { headline: 'Self-updating — all fresh', detail: `${counts.settled}/${counts.total} settled, ${counts.upcoming} upcoming. Monitoring.`, tone: 'pos' };
}
