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
import './modelRunMetadata.test';
import './modelRunHistory.test';
import './modelDataQuality.test';
import './modelRunAttempts.test';
import './modelConfidence.test';
import './modelStakeSuppression.test';
import './modelDataQualitySummary.test';
import './dataQualityUtils.test';
import './modelTipsterConsensus.test';
import './modelRunConfigReaders.test';
import './raceExplanation.test';
import './runnerMatch.test';
import './envPreflight.test';
import './tipsterImportDiagnostics.test';
import './tipsterCandidates.test';
import './importTipsterCandidatesCsv.test';
import './tipsterEvidenceScore.test';
import './tipsterStatus.test';
import './probeRacingApiResultsAccess.test';
import './importResultsCsv.test';
import './demoSeed.test';
import './dbHealthSpec.test';
import './cronDiagnostics.test';
import './cronDate.test';
import './modelPersistenceMapping.test';
import './modelPerformance.test';
import './preOffEvaluation.test';
import './postOffGuard.test';
import './royalAscotDay1Regression.test';
import './raceDaySummary.test';
import './raceCardRunSelection.test';
import './preOffSnapshot.test';
import './dayReport.test';
import './trainingExport.test';
import './relativeTime.test';
import './modelDayRun.test';
import './raceDayPipeline.test';
import './raceDayPipelineRunner.test';
import './raceDayWatch.test';
