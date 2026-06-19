/**
 * Tests for the read-only tipster-match verifier.
 *
 * Proves the pure summary mirrors the consensus rule (a race with matched
 * selections forms a consensus and would clear NO_TIPSTER_CONSENSUS; a race with
 * none does not), and that the CLI is read-only and the lib is pure.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  summarizeTipsterMatch,
  renderTipsterMatchSummary,
  type VerifyRaceInput,
} from '../src/lib/tipsterMatchVerify';

const RACE_WITH_CONSENSUS: VerifyRaceInput = {
  raceId: 'race-1',
  raceName: 'Albany Stakes',
  offTime: '2026-06-19T13:30:00+00:00',
  runnerIds: ['r1', 'r2', 'r3'],
  runnerNames: { r1: 'Sun Goddess', r2: 'Alpha', r3: 'Beta' },
  // Two tipsters back r1, one backs r2 -> consensus = r1.
  tipsterSelections: [{ runner_id: 'r1' }, { runner_id: 'r1' }, { runner_id: 'r2' }],
};

const RACE_NO_SELECTIONS: VerifyRaceInput = {
  raceId: 'race-2',
  raceName: 'Coronation Stakes',
  offTime: '2026-06-19T15:20:00+00:00',
  runnerIds: ['x1', 'x2'],
  runnerNames: { x1: 'Precise', x2: 'True Love' },
  tipsterSelections: [],
};

test('summarize: a race with matched selections forms a consensus and would clear', () => {
  const s = summarizeTipsterMatch('2026-06-19', 'Ascot', [RACE_WITH_CONSENSUS]);
  const race = s.perRace[0];
  assert.equal(race.matchedSelections, 3);
  assert.equal(race.consensusRunnerId, 'r1');
  assert.equal(race.consensusRunnerName, 'Sun Goddess');
  assert.equal(race.consensusWouldClear, true);
  assert.notEqual(race.alignmentLabel, 'NO_TIPSTER_CONSENSUS');
  assert.equal(race.supportedRunners.length, 2); // r1 and r2 have support
});

test('summarize: a race with no selections stays NO_TIPSTER_CONSENSUS', () => {
  const s = summarizeTipsterMatch('2026-06-19', 'Ascot', [RACE_NO_SELECTIONS]);
  const race = s.perRace[0];
  assert.equal(race.matchedSelections, 0);
  assert.equal(race.consensusRunnerId, null);
  assert.equal(race.consensusWouldClear, false);
  assert.equal(race.alignmentLabel, 'NO_TIPSTER_CONSENSUS');
  assert.equal(race.supportedRunners.length, 0);
});

test('summarize: selections on a runner NOT in the race are counted as unmatched', () => {
  const s = summarizeTipsterMatch('2026-06-19', 'Ascot', [
    { ...RACE_NO_SELECTIONS, tipsterSelections: [{ runner_id: 'not-a-runner' }] },
  ]);
  assert.equal(s.perRace[0].matchedSelections, 0);
  assert.equal(s.perRace[0].unmatchedSelections, 1);
  assert.equal(s.perRace[0].consensusWouldClear, false);
});

test('summary: aggregates across races', () => {
  const s = summarizeTipsterMatch('2026-06-19', 'Ascot', [RACE_WITH_CONSENSUS, RACE_NO_SELECTIONS]);
  assert.equal(s.raceCount, 2);
  assert.equal(s.totalMatchedSelections, 3);
  assert.equal(s.racesWithConsensus, 1);
  assert.equal(s.runnersWithSupport, 2);
  assert.equal(s.noConsensusWouldClearAnyRace, true);
});

test('summary: today (no matched selections) reports NO clear', () => {
  const s = summarizeTipsterMatch('2026-06-19', 'Ascot', [RACE_NO_SELECTIONS]);
  assert.equal(s.racesWithConsensus, 0);
  assert.equal(s.noConsensusWouldClearAnyRace, false);
});

test('render: includes the headline metrics', () => {
  const out = renderTipsterMatchSummary(
    summarizeTipsterMatch('2026-06-19', 'Ascot', [RACE_WITH_CONSENSUS, RACE_NO_SELECTIONS]),
  );
  assert.match(out, /Races with a tipster consensus: 1\/2/);
  assert.match(out, /Would NO_TIPSTER_CONSENSUS clear on any race\? YES/);
  assert.match(out, /Sun Goddess/);
});

/* -------------------------------------------------------------------------- */
/* Source scans                                                               */
/* -------------------------------------------------------------------------- */

test('lib is pure: no I/O, reuses buildTipsterConsensus, no model-math change', () => {
  const lib = readFileSync('src/lib/tipsterMatchVerify.ts', 'utf8');
  assert.doesNotMatch(lib, /supabaseAdmin|node:fs|fetch\(|process\.env/);
  assert.match(lib, /buildTipsterConsensus/);
  assert.doesNotMatch(lib, /calculateModelProbabilities|kellyStake|calculateEV|scoreRaceRunners/);
});

test('CLI is read-only: no writes, no model run', () => {
  const cli = readFileSync('scripts/verifyTipsterMatch.ts', 'utf8');
  assert.doesNotMatch(cli, /\.(insert|update|upsert|delete|rpc)\s*\(/);
  assert.doesNotMatch(cli, /runModelForRace|--commit|placeOrder|placeBet/);
  assert.match(cli, /summarizeTipsterMatch/);
});
