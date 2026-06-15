/**
 * Pure builders + guards for the LOCAL-ONLY demo race seed
 * (scripts/seedDemoRaceDay.ts, Batch K1c).
 *
 * These functions construct CLEARLY SYNTHETIC demo data and assert that nothing
 * masquerades as real: every horse/race/tipster name must contain "DEMO" or
 * "SYNTHETIC". They are pure — no I/O, no DB, no randomness, no mutation — so
 * the seed script's data shape is unit-testable without a database, and the
 * safety guard ({@link assertAllSynthetic}) can be verified directly.
 *
 * NOTHING HERE IS REAL DATA. The values are obvious placeholders for local
 * development/testing of the dashboard, model run, tipster importer, and
 * explanation panel without live Racing API / Betfair credentials.
 */

/** Marker found in every demo name; also a clear source/provenance label. */
export const DEMO_SOURCE_LABEL = 'demo-seed';

/** Obviously-synthetic, non-real course / race / country labels. */
export const DEMO_COURSE = 'DEMO Downs (SYNTHETIC)';
export const DEMO_RACE_NAME = 'DEMO Handicap (SYNTHETIC)';
/** A region code is required by the schema; this is a region, not a real name. */
export const DEMO_COUNTRY = 'GB';

/** Allowed synthetic field size (scope: 6–8 runners). */
export const DEMO_RUNNER_MIN = 6;
export const DEMO_RUNNER_MAX = 8;

/** A synthetic runner: a clearly-fake name + a plausible decimal price (> 1). */
export interface DemoRunnerSpec {
  horse_name: string;
  odds_decimal: number;
}

/** A synthetic tipster identity (all fields clearly fake). */
export interface DemoTipsterSpec {
  canonical_name: string;
  display_name: string;
  affiliation: string;
}

/** True when a name is clearly synthetic (contains DEMO or SYNTHETIC). */
export function isDemoName(name: string | null | undefined): boolean {
  return typeof name === 'string' && /demo|synthetic/i.test(name);
}

/**
 * Clamps a requested runner count into the allowed [6, 8] range, defaulting to
 * the maximum when the input is missing or not a finite number. Pure.
 */
export function clampRunnerCount(requested: number | undefined | null): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) {
    return DEMO_RUNNER_MAX;
  }
  const n = Math.floor(requested);
  if (n < DEMO_RUNNER_MIN) return DEMO_RUNNER_MIN;
  if (n > DEMO_RUNNER_MAX) return DEMO_RUNNER_MAX;
  return n;
}

/**
 * A fixed ladder of plausible decimal prices (all > 1, distinct, lengthening),
 * long enough to cover the max field. Deterministic — no randomness — so a
 * re-seed produces the same shape.
 */
const DEMO_ODDS_LADDER: readonly number[] = [
  2.5, 4.0, 5.5, 7.0, 9.0, 13.0, 19.0, 29.0,
];

/**
 * Builds `count` synthetic runners (clamped to [6, 8]) with obviously-fake
 * names ("DEMO Runner N (SYNTHETIC)") and plausible decimal odds taken from a
 * fixed ladder. Pure + deterministic.
 */
export function buildDemoRunnerSpecs(count: number): DemoRunnerSpec[] {
  const n = clampRunnerCount(count);
  const specs: DemoRunnerSpec[] = [];
  for (let i = 0; i < n; i++) {
    specs.push({
      horse_name: `DEMO Runner ${i + 1} (SYNTHETIC)`,
      odds_decimal: DEMO_ODDS_LADDER[i] ?? DEMO_ODDS_LADDER[DEMO_ODDS_LADDER.length - 1],
    });
  }
  return specs;
}

/** Builds three synthetic tipster identities (all names clearly fake). Pure. */
export function buildDemoTipsterSpecs(): DemoTipsterSpec[] {
  return [
    {
      canonical_name: 'DEMO Tipster Alpha (SYNTHETIC)',
      display_name: 'DEMO Tipster Alpha',
      affiliation: 'DEMO Wire (SYNTHETIC)',
    },
    {
      canonical_name: 'DEMO Tipster Bravo (SYNTHETIC)',
      display_name: 'DEMO Tipster Bravo',
      affiliation: 'DEMO Wire (SYNTHETIC)',
    },
    {
      canonical_name: 'DEMO Tipster Charlie (SYNTHETIC)',
      display_name: 'DEMO Tipster Charlie',
      affiliation: 'SYNTHETIC Tips Daily',
    },
  ];
}

/**
 * Safety gate: throws if ANY supplied name is not clearly synthetic. The seed
 * script calls this on every horse/race/tipster name before writing, so a real
 * name can never be inserted by this path even if the builders change.
 */
export function assertAllSynthetic(names: readonly string[]): void {
  const offenders = names.filter((n) => !isDemoName(n));
  if (offenders.length > 0) {
    throw new Error(
      `Refusing to seed: name(s) not marked DEMO/SYNTHETIC: ${offenders.join(', ')}`,
    );
  }
}
