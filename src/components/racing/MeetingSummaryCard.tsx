/**
 * One meeting on a date page: course, race count, scheduled window, link.
 *
 * SERVER COMPONENT. No `'use client'`, no hooks, no data fetching.
 *
 * HISTORICAL ROWS. When the meeting carries no stored `course_key` its href is
 * null, and the card renders as plain text with an explicit explanation rather
 * than a broken or invented link. Nothing is written and no handle is guessed.
 */

import Link from 'next/link';

import {
  canonicalMeetingHref,
  formatOffTime,
  UNAVAILABLE_LABEL,
  type MeetingSummary,
} from '@/lib/racingNavigation';

export interface MeetingSummaryCardProps {
  meeting: MeetingSummary;
  /** The validated route date; the only date used to build the href. */
  date: string;
}

export function MeetingSummaryCard({ meeting, date }: MeetingSummaryCardProps) {
  const href = canonicalMeetingHref(date, meeting.courseKey);
  const first = formatOffTime(meeting.firstOffTime);
  const last = formatOffTime(meeting.lastOffTime);
  const window =
    first === null ? UNAVAILABLE_LABEL : last === null || last === first ? first : `${first} – ${last}`;

  return (
    <article className="rb-card rb-meeting-card">
      <h3 className="rb-card-title">
        {href !== null ? (
          <Link className="rb-inline-link" href={href}>
            {meeting.courseLabel}
          </Link>
        ) : (
          meeting.courseLabel
        )}
      </h3>

      <dl className="rb-meeting-card__facts">
        <div className="rb-meeting-card__fact">
          <dt>Races</dt>
          <dd className="rb-tabular">{meeting.raceCount}</dd>
        </div>
        <div className="rb-meeting-card__fact">
          <dt>Scheduled</dt>
          <dd className="rb-tabular">{window}</dd>
        </div>
        {meeting.country !== null && (
          <div className="rb-meeting-card__fact">
            <dt>Country</dt>
            <dd>{meeting.country}</dd>
          </div>
        )}
      </dl>

      {href === null && (
        <p className="rb-note">
          This meeting was stored before canonical race identity was captured, so it has no
          permanent page. Its races are listed here and are not linked.
        </p>
      )}
    </article>
  );
}

export default MeetingSummaryCard;
