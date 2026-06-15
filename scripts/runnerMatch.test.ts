/**
 * Unit tests for the pure runner matcher (src/lib/runnerMatch.ts).
 *
 * No DB, no network: synthetic runner lists exercise exact normalised matching,
 * case/whitespace handling, no-match, ambiguity, id normalisation, the absence
 * of fuzzy matching, and input immutability. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchRunnerId, type MatchableRunner } from '../src/lib/runnerMatch';

function field(): MatchableRunner[] {
  return [
    { id: 'r1', horse_name: 'Frankel' },
    { id: 'r2', horse_name: 'Sea The Stars' },
    { id: 'r3', horse_name: "O'Brien's Star (IRE)" },
  ];
}

test('exact horse match resolves to that runner id', () => {
  assert.equal(matchRunnerId(field(), 'Frankel'), 'r1');
  assert.equal(matchRunnerId(field(), 'Sea The Stars'), 'r2');
});

test('matching is normalised: case, whitespace, country suffix, punctuation', () => {
  assert.equal(matchRunnerId(field(), '  frankel  '), 'r1');
  assert.equal(matchRunnerId(field(), 'FRANKEL'), 'r1');
  assert.equal(matchRunnerId(field(), 'Frankel (GB)'), 'r1');
  assert.equal(matchRunnerId(field(), 'sea   the   stars'), 'r2');
  // The runner already carries an (IRE) suffix + apostrophes; the same name in a
  // different case/spacing with the country suffix still matches.
  assert.equal(matchRunnerId(field(), "  O'BRIEN'S STAR (ire)  "), 'r3');
});

test('no match returns null (and blank/empty input is null)', () => {
  assert.equal(matchRunnerId(field(), 'Galileo'), null);
  assert.equal(matchRunnerId(field(), ''), null);
  assert.equal(matchRunnerId(field(), '   '), null);
  assert.equal(matchRunnerId([], 'Frankel'), null);
});

test('ambiguous duplicate horse names return null (never guesses)', () => {
  const dupes: MatchableRunner[] = [
    { id: 'a', horse_name: 'Frankel' },
    { id: 'b', horse_name: 'frankel' }, // same name after normalisation
  ];
  assert.equal(matchRunnerId(dupes, 'Frankel'), null);
});

test('numeric runner ids are normalised to strings', () => {
  const numeric: MatchableRunner[] = [
    { id: 42, horse_name: 'Frankel' },
    { id: 7, horse_name: 'Kauto Star' },
  ];
  assert.equal(matchRunnerId(numeric, 'Frankel'), '42');
  assert.equal(matchRunnerId(numeric, 'Kauto Star'), '7');
});

test('no fuzzy matching: partial / superstring names do not match', () => {
  assert.equal(matchRunnerId(field(), 'Frank'), null);
  assert.equal(matchRunnerId(field(), 'Frankels'), null);
  assert.equal(matchRunnerId(field(), 'Sea The Star'), null);
  assert.equal(matchRunnerId(field(), 'The Stars'), null);
});

test('inputs are not mutated', () => {
  const runners = field();
  const snapshot = JSON.parse(JSON.stringify(runners));
  matchRunnerId(runners, 'Frankel');
  matchRunnerId(runners, 'nope');
  assert.deepEqual(runners, snapshot);
});
