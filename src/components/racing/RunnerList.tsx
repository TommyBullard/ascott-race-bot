/**
 * The declared field for one race: horse, draw, age, rating, weight, connections.
 *
 * SERVER COMPONENT. No `'use client'`, no hooks, no data fetching.
 *
 * STORED CARD DATA ONLY. This is the racecard as ingested — it carries no
 * odds, no model probability, no recommendation and no prediction, and it is
 * rendered under a heading that says so. Market and model information live in
 * their own clearly separated region on the race page.
 *
 * PROVIDER IDS ARE ABSENT BY CONSTRUCTION. `NavigationRunnerRow` has no
 * `provider_horse_id`, `trainer_id` or `jockey_id` field, so this component
 * could not render one even by mistake.
 *
 * OVERFLOW. The table is wrapped in `.rb-scroll-x`, so on a narrow viewport
 * the TABLE scrolls sideways inside its own container and the PAGE does not.
 */

import {
  UNAVAILABLE_LABEL,
  displayValue,
  type NavigationRunnerRow,
} from '@/lib/racingNavigation';

export interface RunnerListProps {
  runners: readonly NavigationRunnerRow[];
  /** Accessible caption naming the race this field belongs to. */
  caption: string;
}

/** Right-aligned numeric columns, for the header scope hints. */
const NUMERIC_COLUMNS = new Set(['Draw', 'Age', 'OR', 'Weight (lbs)']);

const COLUMNS = ['Horse', 'Draw', 'Age', 'OR', 'Weight (lbs)', 'Trainer', 'Jockey'] as const;

export function RunnerList({ runners, caption }: RunnerListProps) {
  if (runners.length === 0) {
    return (
      <p className="rb-note">
        No runners are stored for this race. The field is recorded when the racecard is ingested.
      </p>
    );
  }

  return (
    <div className="rb-scroll-x">
      <table className="rb-table">
        <caption className="rb-visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {COLUMNS.map((column) => (
              <th
                key={column}
                scope="col"
                className={NUMERIC_COLUMNS.has(column) ? 'rb-tabular' : undefined}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runners.map((runner) => (
            <tr key={runner.id}>
              <th scope="row">
                {displayValue(runner.horse_name)}
                {typeof runner.runner_status === 'string' &&
                  runner.runner_status.trim() !== '' &&
                  runner.runner_status.trim().toLowerCase() !== 'runner' && (
                    <span className="rb-meta"> ({runner.runner_status.trim()})</span>
                  )}
              </th>
              {/*
                `displayValue` is what keeps an ABSENT value distinct from a
                recorded zero: a null official rating renders "Not recorded",
                while a genuine 0 renders "0".
              */}
              <td className="rb-tabular">{displayValue(runner.draw)}</td>
              <td className="rb-tabular">{displayValue(runner.age)}</td>
              <td className="rb-tabular">{displayValue(runner.official_rating)}</td>
              <td className="rb-tabular">{displayValue(runner.weight_lbs)}</td>
              <td>{displayValue(runner.trainer)}</td>
              <td>{displayValue(runner.jockey)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="rb-note">
        Blank fields are shown as &ldquo;{UNAVAILABLE_LABEL}&rdquo;. That is different from a
        recorded value of zero.
      </p>
    </div>
  );
}

export default RunnerList;
