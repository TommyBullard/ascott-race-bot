/**
 * Race Narrative Intelligence — evidence-gated factual narratives (Phase 4F).
 *
 * Turns quantitative race/runner evidence into short, FACTUAL narrative signals
 * ("Trainer in strong recent form", "Drop in class", "Draw advantage", …) that
 * explain WHY a horse is attractive or WHY confidence should be reduced. It is a
 * decision-support / SHADOW layer with a hard integrity contract:
 *
 *   - EVIDENCE-GATED, NEVER FABRICATED. A detector emits a narrative ONLY when
 *     its required evidence is present AND clears a minimum sample/threshold.
 *     Missing or thin evidence yields NOTHING (no unsupported claim). Every
 *     emitted narrative carries the numbers behind it in `evidence`, so the claim
 *     is auditable.
 *   - DECISION-SUPPORT ONLY. It does NOT change probability, EV, staking,
 *     selection, ranking, or any recommendation. It produces text + structured
 *     evidence for the dashboard and the model-explanation panel.
 *   - PURE. No I/O, no DB, no network, no GenAI. Deterministic given its inputs,
 *     so every rule is unit-testable. The evidence bundle is assembled elsewhere
 *     (stored fields / the Racing API / ingested operator notes) and passed in.
 *
 * Polarity: ATTRACTIVE (a reason to like the runner), CAUTION (a reason to reduce
 * confidence), or CONTEXT (neutral framing). The CAUTION set is exactly the
 * "why confidence is reduced" explanation.
 */

// --- Tunable thresholds (exported so tests + docs stay in sync) ------------

/** Minimum runs/rides behind a trainer/jockey form claim. */
export const MIN_CONNECTION_RUNS = 5;
/** Strike rate at/above which a connection reads as "in strong form". */
export const HOT_STRIKE = 0.2;
/** Strike rate at/below which a connection reads as "cold". */
export const COLD_STRIKE = 0.06;
/** Strike-rate improvement (today vs previous) that reads as a jockey upgrade. */
export const JOCKEY_UPGRADE_DELTA = 0.06;
/** Minimum runs behind a going / course / festival record claim. */
export const MIN_SEGMENT_RUNS = 3;
/** Win rate on a segment at/above which it reads as "suited". */
export const SUITED_WIN_RATE = 0.2;
/** Career runs at/below which a horse is "lightly raced / unexposed". */
export const UNEXPOSED_MAX_RUNS = 3;
/** Front-runner count at/above which the early pace reads as "strong". */
export const STRONG_PACE_FRONT_RUNNERS = 3;

/** Shrinkage K for turning a sample size into a 0..1 data-confidence. */
const CONNECTION_K = 20;
const SEGMENT_K = 8;

// --- Evidence inputs --------------------------------------------------------

/** A connection's (trainer/jockey) recent windowed form. All fields optional. */
export interface ConnectionForm {
  runs?: number | null;
  wins?: number | null;
  /** Win fraction in [0, 1]. */
  strikeRate?: number | null;
  /** Level-stakes ROI fraction. */
  roi?: number | null;
  /** Window length in days (for the claim text). */
  windowDays?: number | null;
  /** Display name (jockey upgrade text). */
  name?: string | null;
}

/** A horse's record over a segment (a going / course / festival). */
export interface SegmentRecord {
  runs?: number | null;
  wins?: number | null;
  places?: number | null;
}

/** Which draw band a course/distance/going favours, with its sample backing. */
export interface DrawBias {
  favoured: 'low' | 'high' | 'middle' | 'none';
  /** Bias strength in [0, 1]. */
  strength?: number | null;
  /** Races behind the bias estimate. */
  sampleSize?: number | null;
}

/** A runner's typical early position. */
export type RunStyle = 'front' | 'prominent' | 'midfield' | 'hold_up';

/** Per-race context evidence (all optional/nullable; absent → not claimed). */
export interface RaceEvidence {
  course?: string | null;
  meetingDate?: string | null;
  isHandicap?: boolean | null;
  fieldSize?: number | null;
  /** Numeric race class (1 = best … 7 = lowest), when known. */
  raceClass?: number | null;
  pattern?: string | null;
  going?: string | null;
  distanceFurlongs?: number | null;
  isFestival?: boolean | null;
  festivalName?: string | null;
  /** Draw bias for this course/distance/going, when known. */
  drawBias?: DrawBias | null;
  /** Number of recognised front-runners in the field (pace setup). */
  frontRunnerCount?: number | null;
}

/** Per-runner evidence (all optional/nullable; absent → not claimed). */
export interface RunnerEvidence {
  runnerId: string | number;
  horseName?: string | null;
  draw?: number | null;
  officialRating?: number | null;
  weightLbs?: number | null;
  trainer?: ConnectionForm | null;
  jockey?: ConnectionForm | null;
  /** The horse's jockey last time (to detect an upgrade). */
  previousJockey?: ConnectionForm | null;
  /** Numeric class of the horse's most recent run (for class moves). */
  lastRaceClass?: number | null;
  goingRecord?: SegmentRecord | null;
  courseRecord?: SegmentRecord | null;
  festivalRecord?: SegmentRecord | null;
  runStyle?: RunStyle | null;
  careerRuns?: number | null;
}

// --- Narrative output -------------------------------------------------------

export type NarrativePolarity = 'ATTRACTIVE' | 'CAUTION' | 'CONTEXT';

export type NarrativeFeature =
  | 'trainer_form'
  | 'jockey_upgrade'
  | 'class_drop'
  | 'class_rise'
  | 'draw_advantage'
  | 'draw_disadvantage'
  | 'ground_suitability'
  | 'course_suitability'
  | 'festival_profile'
  | 'pace_setup'
  | 'unexposed';

/** One evidence-backed narrative signal. */
export interface RaceNarrative {
  /** Runner id the narrative is about, or null for a race-level note. */
  runnerId: string | null;
  feature: NarrativeFeature;
  polarity: NarrativePolarity;
  /** Short factual claim with its evidence embedded. */
  text: string;
  /** The supporting numbers/labels — so the claim is never unsupported. */
  evidence: Record<string, number | string | boolean | null>;
  /** Data sufficiency in [0, 1] (how solid the sample behind the claim is). */
  dataConfidence: number;
}

// --- Small pure helpers -----------------------------------------------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function isNum(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** A sample size → 0..1 confidence via N/(N+K). 0 when absent. */
function sampleConfidence(n: number | null | undefined, k: number): number {
  return isNum(n) && n > 0 ? n / (n + k) : 0;
}

/** Formats a fraction as a 0-dp percent. */
function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// --- Detectors (each returns a narrative or null; pure) --------------------

/** Trainer recent form: strong (attractive) / cold (caution). */
function detectTrainerForm(r: RunnerEvidence): RaceNarrative | null {
  const f = r.trainer;
  if (!f || !isNum(f.runs) || f.runs < MIN_CONNECTION_RUNS || !isNum(f.strikeRate)) return null;
  const window = isNum(f.windowDays) ? `${f.windowDays}d` : 'recent';
  const base = {
    runs: f.runs,
    wins: isNum(f.wins) ? f.wins : null,
    strike_rate: round2(f.strikeRate),
    roi: isNum(f.roi) ? round2(f.roi) : null,
    window_days: isNum(f.windowDays) ? f.windowDays : null,
  };
  const winsText = isNum(f.wins) ? `${f.wins} from ${f.runs}` : `${f.runs} runs`;
  if (f.strikeRate >= HOT_STRIKE) {
    return {
      runnerId: String(r.runnerId),
      feature: 'trainer_form',
      polarity: 'ATTRACTIVE',
      text: `Trainer in strong recent form — ${winsText} (${pct(f.strikeRate)}) over ${window}`,
      evidence: base,
      dataConfidence: sampleConfidence(f.runs, CONNECTION_K),
    };
  }
  if (f.strikeRate <= COLD_STRIKE) {
    return {
      runnerId: String(r.runnerId),
      feature: 'trainer_form',
      polarity: 'CAUTION',
      text: `Trainer out of form — ${winsText} (${pct(f.strikeRate)}) over ${window}`,
      evidence: base,
      dataConfidence: sampleConfidence(f.runs, CONNECTION_K),
    };
  }
  return null;
}

/** Jockey upgrade: today's rider materially out-strikes the previous one. */
function detectJockeyUpgrade(r: RunnerEvidence): RaceNarrative | null {
  const now = r.jockey;
  const prev = r.previousJockey;
  if (!now || !prev) return null;
  if (!isNum(now.strikeRate) || !isNum(prev.strikeRate)) return null;
  if (!isNum(now.runs) || now.runs < MIN_CONNECTION_RUNS) return null;
  if (!isNum(prev.runs) || prev.runs < MIN_CONNECTION_RUNS) return null;
  const delta = now.strikeRate - prev.strikeRate;
  if (delta < JOCKEY_UPGRADE_DELTA) return null;
  return {
    runnerId: String(r.runnerId),
    feature: 'jockey_upgrade',
    polarity: 'ATTRACTIVE',
    text:
      `Jockey upgrade — ${now.name ? `${now.name} ` : ''}${pct(now.strikeRate)} strike vs ` +
      `previous ${pct(prev.strikeRate)}`,
    evidence: {
      jockey_strike: round2(now.strikeRate),
      previous_jockey_strike: round2(prev.strikeRate),
      delta: round2(delta),
      jockey_runs: now.runs,
    },
    dataConfidence: clamp01(
      Math.min(sampleConfidence(now.runs, CONNECTION_K), sampleConfidence(prev.runs, CONNECTION_K)),
    ),
  };
}

/** Class move: drop (attractive) or rise (context/caution). */
function detectClassMove(r: RunnerEvidence, race: RaceEvidence): RaceNarrative | null {
  if (!isNum(race.raceClass) || !isNum(r.lastRaceClass)) return null;
  // Higher class NUMBER = lower grade. raceClass > last → dropping in grade.
  const today = race.raceClass;
  const last = r.lastRaceClass;
  if (today === last) return null;
  const evidence = { today_class: today, last_class: last, steps: Math.abs(today - last) };
  if (today > last) {
    return {
      runnerId: String(r.runnerId),
      feature: 'class_drop',
      polarity: 'ATTRACTIVE',
      text: `Drop in class — from Class ${last} to Class ${today}`,
      evidence,
      dataConfidence: 0.8,
    };
  }
  // Stepping up: context, and caution when also unexposed.
  const unexposed = isNum(r.careerRuns) && r.careerRuns <= UNEXPOSED_MAX_RUNS;
  return {
    runnerId: String(r.runnerId),
    feature: 'class_rise',
    polarity: unexposed ? 'CAUTION' : 'CONTEXT',
    text:
      `Step up in class — from Class ${last} to Class ${today}` +
      (unexposed ? ` (lightly raced)` : ''),
    evidence: { ...evidence, career_runs: isNum(r.careerRuns) ? r.careerRuns : null },
    dataConfidence: 0.8,
  };
}

/** Which third of the field a draw sits in. */
function drawBand(draw: number, fieldSize: number): 'low' | 'high' | 'middle' {
  const third = Math.max(1, Math.ceil(fieldSize / 3));
  if (draw <= third) return 'low';
  if (draw >= fieldSize - third + 1) return 'high';
  return 'middle';
}

/** Draw advantage/disadvantage relative to a sample-backed course bias. */
function detectDraw(r: RunnerEvidence, race: RaceEvidence): RaceNarrative | null {
  const bias = race.drawBias;
  if (!bias || bias.favoured === 'none') return null;
  if (!isNum(r.draw) || !isNum(race.fieldSize) || race.fieldSize < 4) return null;
  const band = drawBand(r.draw, race.fieldSize);
  const conf = clamp01((isNum(bias.strength) ? bias.strength : 0.5) * (bias.sampleSize ? sampleConfidence(bias.sampleSize, 50) : 1));
  const evidence = {
    draw: r.draw,
    field_size: race.fieldSize,
    favoured: bias.favoured,
    bias_strength: isNum(bias.strength) ? round2(bias.strength) : null,
    bias_sample: isNum(bias.sampleSize) ? bias.sampleSize : null,
  };
  if (band === bias.favoured) {
    return {
      runnerId: String(r.runnerId),
      feature: 'draw_advantage',
      polarity: 'ATTRACTIVE',
      text: `Draw advantage — stall ${r.draw} of ${race.fieldSize} sits in the favoured ${bias.favoured} group`,
      evidence,
      dataConfidence: conf,
    };
  }
  // Opposite extreme to the favoured side reads as a disadvantage.
  const opposite = bias.favoured === 'low' ? 'high' : bias.favoured === 'high' ? 'low' : null;
  if (opposite !== null && band === opposite) {
    return {
      runnerId: String(r.runnerId),
      feature: 'draw_disadvantage',
      polarity: 'CAUTION',
      text: `Draw disadvantage — stall ${r.draw} of ${race.fieldSize} is on the unfavoured ${band} side`,
      evidence,
      dataConfidence: conf,
    };
  }
  return null;
}

/** Ground suitability from the horse's record on today's going. */
function detectGoing(r: RunnerEvidence, race: RaceEvidence): RaceNarrative | null {
  const rec = r.goingRecord;
  if (!rec || !isNum(rec.runs) || rec.runs < MIN_SEGMENT_RUNS) return null;
  const wins = isNum(rec.wins) ? rec.wins : 0;
  const places = isNum(rec.places) ? rec.places : 0;
  const winRate = wins / rec.runs;
  const going = race.going ?? 'this ground';
  const evidence = { runs: rec.runs, wins, places, win_rate: round2(winRate), going: race.going ?? null };
  if (wins >= 1 && winRate >= SUITED_WIN_RATE) {
    return {
      runnerId: String(r.runnerId),
      feature: 'ground_suitability',
      polarity: 'ATTRACTIVE',
      text: `Proven on the ground — ${wins} win${wins === 1 ? '' : 's'} from ${rec.runs} on ${going}`,
      evidence,
      dataConfidence: sampleConfidence(rec.runs, SEGMENT_K),
    };
  }
  if (wins === 0 && places === 0) {
    return {
      runnerId: String(r.runnerId),
      feature: 'ground_suitability',
      polarity: 'CAUTION',
      text: `Unproven on the ground — 0 wins/places from ${rec.runs} on ${going}`,
      evidence,
      dataConfidence: sampleConfidence(rec.runs, SEGMENT_K),
    };
  }
  return null;
}

/** Course suitability from the horse's record at the track. */
function detectCourse(r: RunnerEvidence, race: RaceEvidence): RaceNarrative | null {
  const rec = r.courseRecord;
  if (!rec || !isNum(rec.runs) || rec.runs < 1) return null;
  const wins = isNum(rec.wins) ? rec.wins : 0;
  const places = isNum(rec.places) ? rec.places : 0;
  const course = race.course ?? 'this course';
  const evidence = { runs: rec.runs, wins, places, course: race.course ?? null };
  if (wins >= 1) {
    return {
      runnerId: String(r.runnerId),
      feature: 'course_suitability',
      polarity: 'ATTRACTIVE',
      text: `Course winner — ${wins} win${wins === 1 ? '' : 's'} at ${course}`,
      evidence,
      dataConfidence: sampleConfidence(rec.runs, SEGMENT_K),
    };
  }
  if (places >= 2) {
    return {
      runnerId: String(r.runnerId),
      feature: 'course_suitability',
      polarity: 'ATTRACTIVE',
      text: `Course form — placed ${places} times at ${course}`,
      evidence,
      dataConfidence: sampleConfidence(rec.runs, SEGMENT_K),
    };
  }
  return null;
}

/** Festival profile from the horse's record at the festival (when today is one). */
function detectFestival(r: RunnerEvidence, race: RaceEvidence): RaceNarrative | null {
  if (race.isFestival !== true) return null;
  const rec = r.festivalRecord;
  if (!rec || !isNum(rec.runs) || rec.runs < MIN_SEGMENT_RUNS) return null;
  const wins = isNum(rec.wins) ? rec.wins : 0;
  if (wins < 1) return null;
  const label = race.festivalName ?? 'the festival';
  return {
    runnerId: String(r.runnerId),
    feature: 'festival_profile',
    polarity: 'ATTRACTIVE',
    text: `Strong festival profile — ${wins} win${wins === 1 ? '' : 's'} from ${rec.runs} at ${label}`,
    evidence: { runs: rec.runs, wins, places: isNum(rec.places) ? rec.places : null, festival: label },
    dataConfidence: sampleConfidence(rec.runs, SEGMENT_K),
  };
}

/** Pace setup from the field's front-runner count and this runner's run style. */
function detectPace(r: RunnerEvidence, race: RaceEvidence): RaceNarrative | null {
  const fr = race.frontRunnerCount;
  if (!isNum(fr) || !r.runStyle) return null;
  const evidence = { front_runners: fr, run_style: r.runStyle };
  if (r.runStyle === 'front' && fr === 1) {
    return {
      runnerId: String(r.runnerId),
      feature: 'pace_setup',
      polarity: 'ATTRACTIVE',
      text: 'Pace setup — likely the lone leader, can dictate from the front',
      evidence,
      dataConfidence: 0.6,
    };
  }
  if (fr >= STRONG_PACE_FRONT_RUNNERS && (r.runStyle === 'front' || r.runStyle === 'prominent')) {
    return {
      runnerId: String(r.runnerId),
      feature: 'pace_setup',
      polarity: 'CAUTION',
      text: `Pace setup — ${fr} front-runners; a strong early pace may compromise prominent types`,
      evidence,
      dataConfidence: 0.6,
    };
  }
  if (fr >= STRONG_PACE_FRONT_RUNNERS && r.runStyle === 'hold_up') {
    return {
      runnerId: String(r.runnerId),
      feature: 'pace_setup',
      polarity: 'ATTRACTIVE',
      text: `Pace setup — ${fr} front-runners; a fast pace should set up hold-up types`,
      evidence,
      dataConfidence: 0.6,
    };
  }
  return null;
}

/** Lightly-raced / unexposed context (mild caution for confidence). */
function detectUnexposed(r: RunnerEvidence): RaceNarrative | null {
  if (!isNum(r.careerRuns) || r.careerRuns > UNEXPOSED_MAX_RUNS) return null;
  return {
    runnerId: String(r.runnerId),
    feature: 'unexposed',
    polarity: 'CAUTION',
    text: `Lightly raced — only ${r.careerRuns} career run${r.careerRuns === 1 ? '' : 's'}; form is less exposed`,
    evidence: { career_runs: r.careerRuns },
    dataConfidence: 0.7,
  };
}

/** All per-runner detectors, in display order. */
const RUNNER_DETECTORS: ((r: RunnerEvidence, race: RaceEvidence) => RaceNarrative | null)[] = [
  (r) => detectTrainerForm(r),
  (r) => detectJockeyUpgrade(r),
  (r, race) => detectClassMove(r, race),
  (r, race) => detectDraw(r, race),
  (r, race) => detectGoing(r, race),
  (r, race) => detectCourse(r, race),
  (r, race) => detectFestival(r, race),
  (r, race) => detectPace(r, race),
  (r) => detectUnexposed(r),
];

// --- Generator --------------------------------------------------------------

/** Per-runner narratives split by polarity, ready for the explanation panel. */
export interface RunnerNarrativeSummary {
  runnerId: string;
  horseName: string | null;
  /** Reasons the runner is attractive (ATTRACTIVE narratives). */
  attractive: RaceNarrative[];
  /** Reasons to reduce confidence (CAUTION narratives). */
  caution: RaceNarrative[];
  /** Neutral framing (CONTEXT narratives). */
  context: RaceNarrative[];
}

/** The full narrative read-model for one race. */
export interface RaceNarrativeResult {
  /** Every emitted narrative (race-level + per-runner), in detector order. */
  narratives: RaceNarrative[];
  /** Per-runner grouped summaries (only runners with ≥1 narrative). */
  byRunner: RunnerNarrativeSummary[];
}

/**
 * Builds the evidence-gated narratives for a race. Runs every detector over each
 * runner; only evidence-backed narratives are emitted (missing/thin evidence
 * yields nothing). Pure & deterministic. Decision-support only — it changes no
 * model value. The CAUTION narratives are the "why confidence is reduced"
 * explanation; ATTRACTIVE are the "why this horse is attractive" explanation.
 */
export function buildRaceNarratives(
  race: RaceEvidence,
  runners: readonly RunnerEvidence[],
): RaceNarrativeResult {
  const narratives: RaceNarrative[] = [];
  const byRunner: RunnerNarrativeSummary[] = [];

  for (const runner of runners) {
    const runnerId = String(runner.runnerId);
    const emitted: RaceNarrative[] = [];
    for (const detect of RUNNER_DETECTORS) {
      const n = detect(runner, race);
      if (n) emitted.push(n);
    }
    if (emitted.length === 0) continue;
    narratives.push(...emitted);
    byRunner.push({
      runnerId,
      horseName: runner.horseName ?? null,
      attractive: emitted.filter((n) => n.polarity === 'ATTRACTIVE'),
      caution: emitted.filter((n) => n.polarity === 'CAUTION'),
      context: emitted.filter((n) => n.polarity === 'CONTEXT'),
    });
  }

  return { narratives, byRunner };
}

/**
 * Condenses a runner's narratives into the two explanation lists the dashboard
 * and model-explanation panel consume: WHY the runner is attractive, and WHY
 * confidence is reduced. Pure; returns the narrative `text` strings verbatim.
 */
export function summariseRunnerNarratives(
  summary: RunnerNarrativeSummary,
): { attractive: string[]; caution: string[]; context: string[] } {
  return {
    attractive: summary.attractive.map((n) => n.text),
    caution: summary.caution.map((n) => n.text),
    context: summary.context.map((n) => n.text),
  };
}
