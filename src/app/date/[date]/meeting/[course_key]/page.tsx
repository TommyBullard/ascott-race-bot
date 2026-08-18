/**
 * Canonical meeting page — `/date/[date]/meeting/[course_key]`.
 *
 * Lists one meeting's races in scheduled order, each linking to its canonical
 * race page via the STORED `race_slug`.
 *
 * The meeting is resolved by the exact stored tuple (`meeting_date`,
 * `course_key`) — NEVER by the course display label, which is mutable text
 * rather than identity. A tuple that matches no stored row is `notFound()`.
 *
 * SERVER COMPONENT. SELECT-only reads, no service-role value in any prop, no
 * provider call, no model run, no odds capture, no lock, no settlement.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';

import AppShell from '@/components/AppShell';
import { ErrorState, SectionHeader } from '@/components/UiPrimitives';
import Breadcrumbs from '@/components/racing/Breadcrumbs';
import RaceSummaryRow from '@/components/racing/RaceSummaryRow';
import {
  canonicalDateHref,
  decodeRouteSegment,
  formatMeetingDate,
  formatOffTime,
  groupRacesByMeeting,
  isCanonicalDate,
  isCanonicalHandle,
  meetingPageTitle,
  summariseStoredStatuses,
  UNAVAILABLE_LABEL,
} from '@/lib/racingNavigation';
import { loadMeeting } from '@/lib/racingNavigationRead';

interface MeetingPageProps {
  params: Promise<{ date: string; course_key: string }>;
}

/** Validates both untrusted route segments together. */
function readParams(rawDate: string, rawKey: string): { date: string; courseKey: string } | null {
  const date = decodeRouteSegment(rawDate);
  const courseKey = decodeRouteSegment(rawKey);
  if (date === null || courseKey === null) return null;
  if (!isCanonicalDate(date) || !isCanonicalHandle(courseKey)) return null;
  return { date, courseKey };
}

export async function generateMetadata({ params }: MeetingPageProps): Promise<Metadata> {
  const { date: rawDate, course_key: rawKey } = await params;
  const parsed = readParams(rawDate, rawKey);
  if (parsed === null) return { title: 'Meeting not found' };

  const outcome = await loadMeeting(parsed.date, parsed.courseKey);
  if (outcome.kind !== 'ok') return { title: 'Meeting not found' };

  const [meeting] = groupRacesByMeeting(outcome.races);
  const label = meeting?.courseLabel ?? parsed.courseKey;
  const title = meetingPageTitle(label, parsed.date) ?? label;
  return {
    title,
    description: `Stored racecard for ${label} on ${formatMeetingDate(parsed.date)}. Decision-support analytics only.`,
  };
}

export default async function MeetingPage({ params }: MeetingPageProps) {
  const { date: rawDate, course_key: rawKey } = await params;
  const parsed = readParams(rawDate, rawKey);
  if (parsed === null) notFound();

  const { date, courseKey } = parsed;
  const outcome = await loadMeeting(date, courseKey);
  const longDate = formatMeetingDate(date) ?? date;
  const dateHref = canonicalDateHref(date);

  if (outcome.kind === 'read_failed') {
    return (
      <AppShell>
        <Breadcrumbs
          items={[
            { label: 'Racing', href: '/' },
            { label: longDate, href: dateHref },
            { label: courseKey, href: null },
          ]}
        />
        <header className="rb-page-header">
          <h1 className="rb-page-title">Meeting unavailable</h1>
        </header>
        <ErrorState title="Meeting could not be loaded" level={2}>
          The stored racecard for this meeting could not be read. Nothing was changed.
        </ErrorState>
      </AppShell>
    );
  }

  if (outcome.kind === 'not_found') notFound();

  // Grouping here reuses the date page's rule, so the display label and the
  // scheduled window are derived identically on both pages.
  const [meeting] = groupRacesByMeeting(outcome.races);
  const courseLabel = meeting?.courseLabel ?? courseKey;
  const first = formatOffTime(meeting?.firstOffTime ?? null);
  const last = formatOffTime(meeting?.lastOffTime ?? null);

  return (
    <AppShell>
      <Breadcrumbs
        items={[
          { label: 'Racing', href: '/' },
          { label: longDate, href: dateHref },
          { label: courseLabel, href: null },
        ]}
      />

      <header className="rb-page-header">
        <p className="rb-eyebrow">Meeting</p>
        <h1 className="rb-page-title">
          {courseLabel}, {longDate}
        </h1>
        <p className="rb-meta">
          {outcome.races.length} race{outcome.races.length === 1 ? '' : 's'} ·{' '}
          {first === null ? UNAVAILABLE_LABEL : last === null || last === first ? first : `${first} – ${last}`}
          {meeting?.country ? ` · ${meeting.country}` : ''}
        </p>
      </header>

      <section className="rb-panel" aria-label="What is recorded for this meeting">
        <SectionHeader
          level={2}
          eyebrow="Stored data"
          title="Recorded status"
          description="Counts come from the stored racecard rows. No live status is implied, and no capture timestamp is recorded for racecards."
        />
        <ul className="rb-list">
          {summariseStoredStatuses(outcome.races).map((entry) => (
            <li key={entry.label}>
              {entry.label}: <span className="rb-tabular">{entry.count}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Races">
        <SectionHeader level={2} title="Races" description="In scheduled off-time order." />
        <div className="rb-stack">
          {outcome.races.map((race) => (
            <RaceSummaryRow key={race.id} race={race} date={date} />
          ))}
        </div>
      </section>

      {dateHref !== null && (
        <p className="rb-note">
          <Link className="rb-inline-link" href={dateHref}>
            &larr; All meetings on {longDate}
          </Link>
        </p>
      )}
    </AppShell>
  );
}
