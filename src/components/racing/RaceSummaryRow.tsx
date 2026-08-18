/**
 * One race row on a meeting page: off time, name, card attributes, status.
 *
 * SERVER COMPONENT. No `'use client'`, no hooks, no data fetching.
 *
 * Every value comes from a STORED column. A field the card never recorded
 * renders as `Not recorded` rather than as `0`, `–` or an empty cell, so an
 * absent official rating can never be read as a rating of zero.
 *
 * Status is communicated by TEXT plus a glyph, never by colour alone.
 */

import Link from 'next/link';

import {
  canonicalRaceHref,
  describeRaceStatus,
  displayDistance,
  displayValue,
  formatOffTime,
  UNAVAILABLE_LABEL,
  type NavigationRaceRow,
} from '@/lib/racingNavigation';
import { StatusBadge } from '@/components/UiPrimitives';

export interface RaceSummaryRowProps {
  race: NavigationRaceRow;
  /** The validated route date; the only date used to build the href. */
  date: string;
}

export function RaceSummaryRow({ race, date }: RaceSummaryRowProps) {
  const href = canonicalRaceHref(date, race.course_key, race.race_slug);
  const offTime = formatOffTime(race.off_time);
  const status = describeRaceStatus(race);
  const name =
    typeof race.race_name === 'string' && race.race_name.trim() !== ''
      ? race.race_name.trim()
      : UNAVAILABLE_LABEL;

  const facts: { label: string; value: string }[] = [
    { label: 'Type', value: displayValue(race.race_type) },
    { label: 'Distance', value: displayDistance(race) },
    { label: 'Going', value: displayValue(race.going) },
    { label: 'Class', value: displayValue(race.race_class) },
    { label: 'Age band', value: displayValue(race.age_band) },
    { label: 'Field size', value: displayValue(race.field_size) },
  ];

  return (
    <article className="rb-card rb-race-row">
      <div className="rb-race-row__head">
        <span className="rb-race-row__time rb-tabular">
          {offTime ?? UNAVAILABLE_LABEL}
          <span className="rb-visually-hidden">
            {offTime ? ' scheduled off time' : ' scheduled off time not recorded'}
          </span>
        </span>

        <h3 className="rb-card-title rb-race-row__name">
          {href !== null ? (
            <Link className="rb-inline-link" href={href}>
              {name}
            </Link>
          ) : (
            name
          )}
        </h3>

        <StatusBadge tone={status.tone} srLabel="Race status: ">
          {status.label}
        </StatusBadge>
      </div>

      <dl className="rb-race-row__facts">
        {facts.map((fact) => (
          <div className="rb-race-row__fact" key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>

      {href === null && (
        <p className="rb-note">
          Stored before canonical race identity was captured, so this race has no permanent page.
        </p>
      )}
    </article>
  );
}

export default RaceSummaryRow;
