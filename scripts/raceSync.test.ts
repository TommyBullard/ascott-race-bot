/**
 * Unit tests for the live-pipeline pure helpers (src/lib/raceSync.ts and the
 * pure parts of src/lib/betfairExchange.ts).
 *
 * No network, no DB: synthetic fixtures shaped like the verified Racing API /
 * Betfair responses. These lock down normalisation, racecard/result mapping,
 * price extraction, and the (course+off-time)/name matching the crons rely on.
 *
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bundledBetfairPrice,
  indexRunnersByName,
  isHandicap,
  matchMarketToRace,
  normalizeCourse,
  normalizeHorseName,
  racecardRunnerToUpsert,
  racecardToRaceUpsert,
  resolveOffTime,
  resultRunnerToUpdate,
  toPriceOrNull,
} from '../src/lib/raceSync';
import {
  extractBackPrice,
  toMatchableMarket,
} from '../src/lib/betfairExchange';

// --- normalisation ---------------------------------------------------------

test('normalizeHorseName: strips country suffix, punctuation, case', () => {
  assert.equal(normalizeHorseName('Frankel (GB)'), 'frankel');
  assert.equal(normalizeHorseName("O'Brien's Star (IRE)"), 'o brien s star');
  assert.equal(normalizeHorseName('  Pistoletto  '), 'pistoletto');
  assert.equal(normalizeHorseName(undefined), '');
});

test('normalizeCourse: strips (AW), punctuation, case', () => {
  assert.equal(normalizeCourse('Lingfield (AW)'), 'lingfield');
  assert.equal(normalizeCourse('Newmarket'), 'newmarket');
  assert.equal(normalizeCourse('Bangor-on-Dee'), 'bangor on dee');
});

test('normalizeCourse: Royal Ascot aliases to ascot; plain Ascot unchanged', () => {
  assert.equal(normalizeCourse('Ascot'), 'ascot');
  assert.equal(normalizeCourse('Royal Ascot'), 'ascot');
  assert.equal(normalizeCourse('ROYAL ASCOT'), 'ascot');
  assert.equal(normalizeCourse('  Royal   Ascot  '), 'ascot');
  assert.equal(normalizeCourse('Royal-Ascot'), 'ascot');
  // The alias is exact + narrow: it must not rewrite unrelated venues, nor a
  // 'royal' that is part of a different name.
  assert.equal(normalizeCourse('Wolverhampton (AW)'), 'wolverhampton');
  assert.equal(normalizeCourse('Royal Windsor'), 'royal windsor');
  assert.equal(normalizeCourse('Ascott'), 'ascott'); // not Ascot, unchanged
});

test('course filter (recommendations ?course): normalised equality is the predicate', () => {
  // Mirrors the /api/recommendations course filter:
  //   normalizeCourse(card.course) === normalizeCourse(wantCourse)
  const cards = [
    { course: 'Ascot' },
    { course: 'Royal Ascot' }, // DB might store either; both should match.
    { course: 'Windsor' },
    { course: null },
  ];
  const want = normalizeCourse('Ascot');
  const kept = cards.filter((c) => normalizeCourse(c.course) === want);
  assert.deepEqual(kept.map((c) => c.course), ['Ascot', 'Royal Ascot']);

  // Querying by the Betfair-style label still selects the Ascot card(s).
  const wantRoyal = normalizeCourse('Royal Ascot');
  assert.deepEqual(
    cards.filter((c) => normalizeCourse(c.course) === wantRoyal).map((c) => c.course),
    ['Ascot', 'Royal Ascot'],
  );
});

test('toPriceOrNull: only real prices > 1', () => {
  assert.equal(toPriceOrNull('6.5'), 6.5);
  assert.equal(toPriceOrNull('1'), null);
  assert.equal(toPriceOrNull(''), null);
  assert.equal(toPriceOrNull('abc'), null);
  assert.equal(toPriceOrNull(undefined), null);
});

test('isHandicap: detects handicap/hcap in any supplied text', () => {
  assert.equal(isHandicap('Apprentice Handicap'), true);
  assert.equal(isHandicap('6f Hcap'), true);
  assert.equal(isHandicap('Maiden Stakes', 'Class 5'), false);
});

// --- off-time resolution ---------------------------------------------------

test('resolveOffTime: prefers off_dt ISO; derives meeting date', () => {
  const r = resolveOffTime('2026-06-12T13:50:00+01:00', '2026-06-12', '13:50');
  assert.ok(r);
  assert.equal(r!.meetingDate, '2026-06-12');
  assert.equal(r!.offTimeIso, new Date('2026-06-12T13:50:00+01:00').toISOString());
});

test('resolveOffTime: falls back to date + off_time (UTC); null when unparseable', () => {
  const r = resolveOffTime(undefined, '2026-06-12', '14:30');
  assert.ok(r);
  assert.equal(r!.offTimeIso, '2026-06-12T14:30:00.000Z');
  assert.equal(r!.meetingDate, '2026-06-12');
  assert.equal(resolveOffTime(undefined, undefined, undefined), null);
  assert.equal(resolveOffTime('not a date', undefined, undefined), null);
});

// --- racecard mapping ------------------------------------------------------

test('racecardToRaceUpsert: maps fields, sets scheduled, flags handicap', () => {
  const row = racecardToRaceUpsert({
    race_id: 'rac_1',
    course: 'Ascot',
    region: 'GB',
    race_name: '2:30 Royal Handicap',
    race_class: 'Class 2',
    off_dt: '2026-06-12T14:30:00+01:00',
    date: '2026-06-12',
    off_time: '2:30',
    runners: [],
  });
  assert.ok(row);
  assert.equal(row!.course, 'Ascot');
  assert.equal(row!.country, 'GB');
  assert.equal(row!.status, 'scheduled');
  assert.equal(row!.handicap_flag, true);
  assert.equal(row!.meeting_date, '2026-06-12');
});

test('racecardToRaceUpsert: null for abandoned / no course / no off time', () => {
  assert.equal(racecardToRaceUpsert({ course: 'Ascot', off_dt: '2026-06-12T14:30:00Z', is_abandoned: true }), null);
  assert.equal(racecardToRaceUpsert({ course: '', off_dt: '2026-06-12T14:30:00Z' }), null);
  assert.equal(racecardToRaceUpsert({ course: 'Ascot', off_dt: 'bad', date: undefined }), null);
});

test('racecardRunnerToUpsert: maps numerics, declared status; null w/o horse', () => {
  const row = racecardRunnerToUpsert({
    horse: 'Alpha (IRE)',
    number: '3',
    draw: '5',
    ofr: '88',
    lbs: '140',
    trainer: 'A Trainer',
    jockey: 'A Jockey',
  });
  assert.ok(row);
  assert.equal(row!.horse_name, 'Alpha (IRE)');
  assert.equal(row!.saddlecloth, 3);
  assert.equal(row!.draw, 5);
  assert.equal(row!.official_rating, 88);
  assert.equal(row!.weight_lbs, 140);
  assert.equal(row!.runner_status, 'declared');
  assert.equal(racecardRunnerToUpsert({ horse: '' }), null);
});

test('basic racecard payload (no odds) maps to races + runners unchanged', () => {
  // A card from the basic/free endpoint: same shape as standard MINUS `odds`,
  // and (for the free tier) often without race_class / official rating / weight.
  // Ingestion writes only races + runners, so the absence of odds is irrelevant;
  // missing advanced fields map to null, never fabricated.
  const race = racecardToRaceUpsert({
    race_id: 'rac_basic',
    course: 'Newcastle',
    region: 'GB',
    race_name: '13:00 Maiden Stakes',
    off_dt: '2026-06-15T13:00:00+01:00',
    date: '2026-06-15',
    off_time: '13:00',
    runners: [{ horse: 'Demo Free Runner', number: '1', trainer: 'T', jockey: 'J' }],
  });
  assert.ok(race);
  assert.equal(race!.course, 'Newcastle');
  assert.equal(race!.status, 'scheduled');
  assert.equal(race!.handicap_flag, false); // no "handicap" in the name/class
  assert.equal(race!.meeting_date, '2026-06-15');

  // A basic runner with NO odds, NO official rating, NO weight.
  const runner = racecardRunnerToUpsert({
    horse: 'Demo Free Runner',
    number: '1',
    draw: '4',
    trainer: 'T',
    jockey: 'J',
  });
  assert.ok(runner);
  assert.equal(runner!.horse_name, 'Demo Free Runner');
  assert.equal(runner!.saddlecloth, 1);
  assert.equal(runner!.draw, 4);
  // Advanced fields absent on basic cards -> null (honest, not fabricated).
  assert.equal(runner!.official_rating, null);
  assert.equal(runner!.weight_lbs, null);
  assert.equal(runner!.runner_status, 'declared');
});

test('bundledBetfairPrice: reads the Betfair Exchange odds entry', () => {
  const price = bundledBetfairPrice({
    horse: 'Alpha',
    odds: [
      { bookmaker: 'Bet365', decimal: '9' },
      { bookmaker: 'Betfair Exchange', decimal: '8.5' },
    ],
  });
  assert.equal(price, 8.5);
  assert.equal(bundledBetfairPrice({ horse: 'Alpha', odds: [{ bookmaker: 'Bet365', decimal: '9' }] }), null);
});

// --- result mapping --------------------------------------------------------

test('resultRunnerToUpdate: parses position/bsp/sp; non-finisher -> null pos', () => {
  const won = resultRunnerToUpdate({ horse: 'Alpha (GB)', position: '1', bsp: '3.62', sp_dec: '3.5' });
  assert.ok(won);
  assert.equal(won!.matchKey, 'alpha');
  assert.equal(won!.finishPos, 1);
  assert.equal(won!.bspDecimal, 3.62);
  assert.equal(won!.spDecimal, 3.5);

  const pu = resultRunnerToUpdate({ horse: 'Beta', position: 'PU', bsp: '' });
  assert.ok(pu);
  assert.equal(pu!.finishPos, null);
  assert.equal(pu!.bspDecimal, null);

  assert.equal(resultRunnerToUpdate({ horse: '' }), null);
});

// --- matching --------------------------------------------------------------

test('matchMarketToRace: matches on course + off-time within tolerance', () => {
  const markets = [
    { marketId: '1.1', venue: 'Ascot', marketStartIso: '2026-06-12T14:30:30Z' },
    { marketId: '1.2', venue: 'York', marketStartIso: '2026-06-12T14:30:00Z' },
    { marketId: '1.3', venue: 'Ascot', marketStartIso: '2026-06-12T15:00:00Z' },
  ];
  const m = matchMarketToRace({ course: 'Ascot', offTimeIso: '2026-06-12T14:30:00Z' }, markets);
  assert.equal(m?.marketId, '1.1'); // same venue, within 90s

  // No venue match -> null.
  assert.equal(
    matchMarketToRace({ course: 'Kempton', offTimeIso: '2026-06-12T14:30:00Z' }, markets),
    null,
  );
  // Off-time too far -> null.
  assert.equal(
    matchMarketToRace({ course: 'Ascot', offTimeIso: '2026-06-12T16:00:00Z' }, markets),
    null,
  );
});

test('matchMarketToRace: Betfair "Royal Ascot" venue matches a DB "Ascot" race', () => {
  const markets = [
    { marketId: '2.1', venue: 'Royal Ascot', marketStartIso: '2026-06-16T13:30:20Z' },
    { marketId: '2.2', venue: 'York', marketStartIso: '2026-06-16T13:30:00Z' },
    { marketId: '2.3', venue: 'Royal Ascot', marketStartIso: '2026-06-16T16:00:00Z' },
  ];
  // Queen Anne Stakes: DB course 'Ascot', off 13:30 UTC -> matches the Royal
  // Ascot market within tolerance.
  const m = matchMarketToRace({ course: 'Ascot', offTimeIso: '2026-06-16T13:30:00Z' }, markets);
  assert.equal(m?.marketId, '2.1');

  // Time tolerance still enforced: a Royal Ascot venue at the wrong time -> null.
  assert.equal(
    matchMarketToRace({ course: 'Ascot', offTimeIso: '2026-06-16T15:00:00Z' }, markets),
    null,
  );
  // Unrelated course still does not match the Royal Ascot markets.
  assert.equal(
    matchMarketToRace({ course: 'Kempton', offTimeIso: '2026-06-16T13:30:00Z' }, markets),
    null,
  );
});

test('indexRunnersByName: maps normalised name -> id, first wins', () => {
  const idx = indexRunnersByName([
    { id: 'r1', horse_name: 'Alpha (IRE)' },
    { id: 'r2', horse_name: 'Bravo' },
  ]);
  assert.equal(idx.get('alpha'), 'r1');
  assert.equal(idx.get('bravo'), 'r2');
  assert.equal(idx.get('charlie'), undefined);
});

// --- betfair pure helpers --------------------------------------------------

test('extractBackPrice: prefers availableToBack, then lastTraded, then SP', () => {
  assert.equal(
    extractBackPrice({ ex: { availableToBack: [{ price: 4.6 }] }, lastPriceTraded: 4.5 }),
    4.6,
  );
  assert.equal(extractBackPrice({ lastPriceTraded: 4.5 }), 4.5);
  assert.equal(extractBackPrice({ sp: { nearPrice: 5.2 } }), 5.2);
  assert.equal(extractBackPrice({ ex: { availableToBack: [{ price: 1 }] } }), null);
  assert.equal(extractBackPrice({}), null);
});

test('toMatchableMarket: flattens catalogue to {marketId, venue, start, runners}', () => {
  const m = toMatchableMarket({
    marketId: '1.99',
    marketStartTime: '2026-06-12T14:30:00Z',
    event: { venue: 'Ascot' },
    runners: [{ selectionId: 1, runnerName: 'Alpha' }],
  });
  assert.equal(m.marketId, '1.99');
  assert.equal(m.venue, 'Ascot');
  assert.equal(m.marketStartIso, '2026-06-12T14:30:00Z');
  assert.equal(m.runners.length, 1);
});
