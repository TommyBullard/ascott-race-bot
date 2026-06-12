/**
 * CLI: run the model for a single race and print whatever it returns.
 *
 * Usage:        npm run run:model -- <race_id>
 * Equivalent:   tsx scripts/runModel.ts <race_id>
 *
 * Loads credentials from `.env.local`. This uses the service-role client, which
 * BYPASSES RLS and WRITES to your database: it inserts a new model run and its
 * child rows, and deletes any older runs for the race.
 */

import { runModelForRace } from '../src/lib/runModelForRace';

async function main(): Promise<void> {
  const raceId = process.argv[2];
  if (!raceId) {
    console.error('Usage: npm run run:model -- <race_id>');
    process.exit(1);
  }

  process.loadEnvFile('.env.local');

  const result = await runModelForRace(raceId);
  console.log(result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
