/**
 * Unit tests for the Race Narrative Intelligence engine
 * (src/lib/raceNarrativeIntelligence.ts).
 *
 * No network or DB. These lock the EVIDENCE-GATING contract (no evidence → no
 * claim), every feature detector (attractive / caution / context), and the
 * per-runner grouping the dashboard + model-explanation panel consume.
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRaceNarratives,
  summariseRunnerNarratives,
  type RaceEvidence,
  type RunnerEvidence,
} from '../src/lib/raceNarrativeIntelligence';

/** Finds a runner's emitted narratives in the result. */
function narrativesFor(result: ReturnType<typeof buildRaceNarratives>, id: string) {
  return result.narratives.filter((n) => n.runnerId === id);
}

test('evidence-gating: a runner with no evidence yields NO narratives (no fabrication)', () => {
  const result = buildRaceNarratives({}, [{ runnerId: 'A', horseName: 'Bare' }]);
  assert.equal(result.narratives.length, 0);
  assert.equal(result.byRunner.length, 0);
});

test('trainer_form: strong strike -> ATTRACTIVE; cold -> CAUTION; thin sample -> none', () => {
  const hot = buildRaceNarratives({}, [
    { runnerId: 'A', trainer: { runs: 30, wins: 9, strikeRate: 0.3, windowDays: 14 } },
  ]);
  const n = narrativesFor(hot, 'A').find((x) => x.feature === 'trainer_form');
  assert.ok(n);
  assert.equal(n?.polarity, 'ATTRACTIVE');
  assert.match(n!.text, /strong recent form/);
  assert.equal(n!.evidence.runs, 30);

  const cold = buildRaceNarratives({}, [
    { runnerId: 'B', trainer: { runs: 40, wins: 1, strikeRate: 0.025, windowDays: 14 } },
  ]);
  assert.equal(narrativesFor(cold, 'B').find((x) => x.feature === 'trainer_form')?.polarity, 'CAUTION');

  const thin = buildRaceNarratives({}, [
    { runnerId: 'C', trainer: { runs: 3, wins: 2, strikeRate: 0.66 } }, // < MIN_CONNECTION_RUNS
  ]);
  assert.equal(narrativesFor(thin, 'C').length, 0);
});

test('jockey_upgrade: material strike improvement -> ATTRACTIVE; small -> none', () => {
  const up = buildRaceNarratives({}, [
    {
      runnerId: 'A',
      jockey: { runs: 200, strikeRate: 0.2, name: 'Top Rider' },
      previousJockey: { runs: 50, strikeRate: 0.08 },
    },
  ]);
  const n = narrativesFor(up, 'A').find((x) => x.feature === 'jockey_upgrade');
  assert.equal(n?.polarity, 'ATTRACTIVE');
  assert.match(n!.text, /Jockey upgrade/);

  const flat = buildRaceNarratives({}, [
    {
      runnerId: 'B',
      jockey: { runs: 200, strikeRate: 0.12 },
      previousJockey: { runs: 50, strikeRate: 0.1 }, // delta 0.02 < threshold
    },
  ]);
  assert.equal(narrativesFor(flat, 'B').length, 0);
});

test('class move: drop -> ATTRACTIVE; rise -> CONTEXT; rise + unexposed -> CAUTION', () => {
  const drop = buildRaceNarratives({ raceClass: 4 }, [{ runnerId: 'A', lastRaceClass: 2 }]);
  const d = narrativesFor(drop, 'A')[0];
  assert.equal(d.feature, 'class_drop');
  assert.equal(d.polarity, 'ATTRACTIVE');

  const rise = buildRaceNarratives({ raceClass: 2 }, [{ runnerId: 'B', lastRaceClass: 4, careerRuns: 12 }]);
  const r = narrativesFor(rise, 'B')[0];
  assert.equal(r.feature, 'class_rise');
  assert.equal(r.polarity, 'CONTEXT');

  const riseUnexposed = buildRaceNarratives({ raceClass: 2 }, [
    { runnerId: 'C', lastRaceClass: 4, careerRuns: 2 },
  ]);
  assert.equal(narrativesFor(riseUnexposed, 'C').find((x) => x.feature === 'class_rise')?.polarity, 'CAUTION');
});

test('draw: favoured band -> advantage; opposite extreme -> disadvantage; no bias -> none', () => {
  const race: RaceEvidence = { fieldSize: 12, drawBias: { favoured: 'low', strength: 0.7, sampleSize: 120 } };
  const adv = buildRaceNarratives(race, [{ runnerId: 'A', draw: 2 }]);
  assert.equal(narrativesFor(adv, 'A')[0].feature, 'draw_advantage');

  const dis = buildRaceNarratives(race, [{ runnerId: 'B', draw: 12 }]);
  assert.equal(narrativesFor(dis, 'B')[0].feature, 'draw_disadvantage');
  assert.equal(narrativesFor(dis, 'B')[0].polarity, 'CAUTION');

  const noBias = buildRaceNarratives({ fieldSize: 12, drawBias: { favoured: 'none' } }, [{ runnerId: 'C', draw: 1 }]);
  assert.equal(narrativesFor(noBias, 'C').length, 0);
});

test('ground suitability: proven -> ATTRACTIVE; winless+placeless -> CAUTION; thin -> none', () => {
  const proven = buildRaceNarratives({ going: 'Soft' }, [
    { runnerId: 'A', goingRecord: { runs: 6, wins: 2, places: 4 } },
  ]);
  assert.equal(narrativesFor(proven, 'A')[0].feature, 'ground_suitability');
  assert.equal(narrativesFor(proven, 'A')[0].polarity, 'ATTRACTIVE');

  const poor = buildRaceNarratives({ going: 'Heavy' }, [
    { runnerId: 'B', goingRecord: { runs: 5, wins: 0, places: 0 } },
  ]);
  assert.equal(narrativesFor(poor, 'B')[0].polarity, 'CAUTION');

  const thin = buildRaceNarratives({ going: 'Good' }, [{ runnerId: 'C', goingRecord: { runs: 2, wins: 1 } }]);
  assert.equal(narrativesFor(thin, 'C').length, 0);
});

test('course suitability + festival profile: emitted only with the record (and festival flag)', () => {
  const course = buildRaceNarratives({ course: 'Ascot' }, [
    { runnerId: 'A', courseRecord: { runs: 5, wins: 2, places: 3 } },
  ]);
  assert.equal(narrativesFor(course, 'A')[0].feature, 'course_suitability');

  // Festival record present but NOT a festival day -> no festival narrative.
  const notFestival = buildRaceNarratives({ isFestival: false }, [
    { runnerId: 'B', festivalRecord: { runs: 6, wins: 2 } },
  ]);
  assert.equal(narrativesFor(notFestival, 'B').find((x) => x.feature === 'festival_profile'), undefined);

  const festival = buildRaceNarratives({ isFestival: true, festivalName: 'Royal Ascot' }, [
    { runnerId: 'C', festivalRecord: { runs: 6, wins: 2, places: 4 } },
  ]);
  assert.equal(narrativesFor(festival, 'C')[0].feature, 'festival_profile');
});

test('pace setup: lone leader -> ATTRACTIVE; many front-runners + prominent -> CAUTION; hold-up -> ATTRACTIVE', () => {
  const lone = buildRaceNarratives({ frontRunnerCount: 1 }, [{ runnerId: 'A', runStyle: 'front' }]);
  assert.equal(narrativesFor(lone, 'A')[0].polarity, 'ATTRACTIVE');

  const contested = buildRaceNarratives({ frontRunnerCount: 4 }, [{ runnerId: 'B', runStyle: 'prominent' }]);
  assert.equal(narrativesFor(contested, 'B')[0].polarity, 'CAUTION');

  const closer = buildRaceNarratives({ frontRunnerCount: 4 }, [{ runnerId: 'C', runStyle: 'hold_up' }]);
  assert.equal(narrativesFor(closer, 'C')[0].polarity, 'ATTRACTIVE');
});

test('generator: groups by runner, splits polarity, excludes runners with no narrative', () => {
  const race: RaceEvidence = { raceClass: 5, course: 'Ascot', going: 'Good' };
  const runners: RunnerEvidence[] = [
    {
      runnerId: 'A',
      horseName: 'Strong One',
      trainer: { runs: 40, wins: 14, strikeRate: 0.35, windowDays: 14 },
      lastRaceClass: 2, // drop in class
      goingRecord: { runs: 8, wins: 3, places: 6 },
      careerRuns: 2, // unexposed caution
    },
    { runnerId: 'B', horseName: 'No Evidence' }, // emits nothing
  ];
  const result = buildRaceNarratives(race, runners);
  assert.equal(result.byRunner.length, 1);
  const a = result.byRunner[0];
  assert.equal(a.runnerId, 'A');
  assert.ok(a.attractive.length >= 2); // trainer form + class drop + ground
  assert.ok(a.caution.length >= 1); // unexposed

  const summary = summariseRunnerNarratives(a);
  assert.ok(summary.attractive.some((t) => /strong recent form/.test(t)));
  assert.ok(summary.caution.some((t) => /Lightly raced/.test(t)));
});

test('every emitted narrative carries evidence and a [0,1] data confidence', () => {
  const result = buildRaceNarratives({ raceClass: 4 }, [
    { runnerId: 'A', trainer: { runs: 30, wins: 9, strikeRate: 0.3 }, lastRaceClass: 2 },
  ]);
  assert.ok(result.narratives.length > 0);
  for (const n of result.narratives) {
    assert.ok(n.evidence && typeof n.evidence === 'object');
    assert.ok(n.dataConfidence >= 0 && n.dataConfidence <= 1);
    assert.ok(n.text.length > 0);
  }
});
