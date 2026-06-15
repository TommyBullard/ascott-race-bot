/**
 * Aggregate test entry point.
 *
 * Imports every *.test.ts module so a single `npm test` runs the whole suite
 * via Node's built-in test runner (which collects all registered tests on
 * import). This avoids shell globbing and experimental flags, so it behaves
 * the same on every platform.
 */

import './scenarios.test';
import './canonicalTipster.test';
import './discoverTipsters.test';
import './racingApi.test';
import './backtest.test';
import './historicalRaceLoader.test';
import './betfairBsp.test';
import './raceSync.test';
import './auth.test';
