/**
 * Unit tests for the historical-race loader validation core.
 *
 * Pure, synthetic fixtures — no DB, no file I/O. These lock down the structural
 * validation, the per-race "would it count in the backtest" classification, and
 * the placeholder-EXAMPLE detection that gates --commit. They assert the rules,
 * not any real race.
 *
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateImport } from '../src/lib/historicalRaceLoader';

/** A minimal valid race: 2 priced runners, one winner with BSP. */
function validRace(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    course: 'Ascot',
    country: 'GB',
    race_name: 'Test Stakes',
    meeting_date: '2025-06-18',
    off_time: '2025-06-18T14:30:00Z',
    runners: [
      { horse_name: 'Alpha', odds_decimal: 3.5, bsp_decimal: 3.6, finish_pos: 1 },
      { horse_name: 'Bravo', odds_decimal: 5.0, bsp_decimal: 5.2, finish_pos: 2 },
    ],
    ...over,
  };
}

test('validateImport: a valid race counts, with no errors', () => {
  const res = validateImport({ races: [validRace()] });
  assert.deepEqual(res.errors, []);
  assert.equal(res.races.length, 1);
  assert.equal(res.races[0].wouldCount, true);
  assert.equal(res.races[0].pricedCount, 2);
  assert.equal(res.races[0].winnerHorse, 'Alpha');
  assert.equal(res.races[0].winnerHasBsp, true);
  assert.equal(res.countable, 1);
});

test('validateImport: top-level must be an object with a non-empty races array', () => {
  assert.ok(validateImport(null).errors.length > 0);
  assert.ok(validateImport({}).errors.some((e) => e.includes('races')));
  assert.ok(validateImport({ races: [] }).errors.some((e) => e.includes('races')));
});

test('validateImport: missing required race fields are errors', () => {
  const res = validateImport({
    races: [{ course: 'X', runners: [{ horse_name: 'A', odds_decimal: 2 }] }],
  });
  const joined = res.errors.join('\n');
  assert.ok(joined.includes('country'));
  assert.ok(joined.includes('race_name'));
  assert.ok(joined.includes('meeting_date'));
  assert.ok(joined.includes('off_time'));
});

test('validateImport: bad prices and finish positions are errors', () => {
  const res = validateImport({
    races: [
      validRace({
        runners: [
          { horse_name: 'A', odds_decimal: 1.0 }, // <= 1 invalid
          { horse_name: 'B', odds_decimal: 4, finish_pos: 0 }, // < 1 invalid
          { horse_name: 'C', odds_decimal: 4, bsp_decimal: 0.5 }, // <= 1 invalid
        ],
      }),
    ],
  });
  const joined = res.errors.join('\n');
  assert.ok(joined.includes('odds_decimal'));
  assert.ok(joined.includes('finish_pos'));
  assert.ok(joined.includes('bsp_decimal'));
});

test('validateImport: duplicate horse names and multiple winners are errors', () => {
  const dup = validateImport({
    races: [
      validRace({
        runners: [
          { horse_name: 'Alpha', odds_decimal: 3 },
          { horse_name: 'alpha', odds_decimal: 4 },
        ],
      }),
    ],
  });
  assert.ok(dup.errors.some((e) => e.includes('duplicate horse_name')));

  const twoWinners = validateImport({
    races: [
      validRace({
        runners: [
          { horse_name: 'A', odds_decimal: 3, finish_pos: 1 },
          { horse_name: 'B', odds_decimal: 4, finish_pos: 1 },
        ],
      }),
    ],
  });
  assert.ok(twoWinners.errors.some((e) => e.includes('finish_pos=1')));
});

test('validateImport: a selection must reference a runner in the race', () => {
  const res = validateImport({
    races: [
      validRace({
        tipster_selections: [{ tipster_name: 'T', horse_name: 'Ghost' }],
      }),
    ],
  });
  assert.ok(res.errors.some((e) => e.includes('does not match any runner')));
});

test('validateImport: no winner / no priced runner -> warning + would not count', () => {
  const noWinner = validateImport({
    races: [
      validRace({
        runners: [
          { horse_name: 'A', odds_decimal: 3 },
          { horse_name: 'B', odds_decimal: 4 },
        ],
      }),
    ],
  });
  assert.deepEqual(noWinner.errors, []);
  assert.equal(noWinner.races[0].wouldCount, false);
  assert.equal(noWinner.countable, 0);
  assert.ok(noWinner.warnings.some((w) => w.includes('no winner')));

  const noPrice = validateImport({
    races: [
      validRace({
        runners: [
          { horse_name: 'A', finish_pos: 1 },
          { horse_name: 'B', finish_pos: 2 },
        ],
      }),
    ],
  });
  assert.equal(noPrice.races[0].wouldCount, false);
  assert.ok(noPrice.warnings.some((w) => w.includes('no priced runners')));
});

test('validateImport: winner without BSP warns about ROI fallback (still counts)', () => {
  const res = validateImport({
    races: [
      validRace({
        runners: [
          { horse_name: 'A', odds_decimal: 3.5, finish_pos: 1 },
          { horse_name: 'B', odds_decimal: 5, finish_pos: 2 },
        ],
      }),
    ],
  });
  assert.deepEqual(res.errors, []);
  assert.equal(res.races[0].wouldCount, true);
  assert.equal(res.races[0].winnerHasBsp, false);
  assert.ok(res.warnings.some((w) => w.includes('fall back to quoted odds')));
});

test('validateImport: linkable selections counted; warns when none linkable', () => {
  const withPrior = validateImport({
    races: [validRace({ tipster_selections: [{ tipster_name: 'Sharp Sam', horse_name: 'Alpha' }] })],
    tipsters: [
      { canonical_name: 'Sharp Sam', as_of_date: '2025-06-18', bets_count: 200, wins_count: 60 },
    ],
  });
  assert.deepEqual(withPrior.errors, []);
  assert.equal(withPrior.races[0].linkableSelectionCount, 1);
  assert.equal(withPrior.tipsterCount, 1);

  const noPrior = validateImport({
    races: [validRace({ tipster_selections: [{ tipster_name: 'Nobody', horse_name: 'Alpha' }] })],
  });
  assert.equal(noPrior.races[0].linkableSelectionCount, 0);
  assert.ok(noPrior.warnings.some((w) => w.includes('needle mode will match the control')));
});

test('validateImport: no tipster priors -> warns needle equals control', () => {
  const res = validateImport({ races: [validRace()] });
  assert.ok(res.warnings.some((w) => w.includes('needle mode will equal the control')));
});

test('validateImport: placeholder EXAMPLE text is detected', () => {
  const res = validateImport({
    races: [validRace({ course: 'EXAMPLE Downs' })],
  });
  assert.equal(res.hasPlaceholder, true);

  const clean = validateImport({ races: [validRace()] });
  assert.equal(clean.hasPlaceholder, false);
});

test('validateImport: invalid enum values are errors', () => {
  const res = validateImport({
    races: [
      validRace({
        status: 'finished', // not in race_status
        runners: [
          { horse_name: 'A', odds_decimal: 3, finish_pos: 1, status: 'galloped' }, // not in runner_status
          { horse_name: 'B', odds_decimal: 4, finish_pos: 2 },
        ],
      }),
    ],
  });
  const joined = res.errors.join('\n');
  assert.ok(joined.includes('status must be one of'));
});
