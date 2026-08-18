/**
 * Canonical date page — `/date/[date]`.
 *
 * Lists every stored meeting on one ISO calendar date, grouped by the STORED
 * `races.course_key`, with previous/next day navigation.
 *
 * SERVER COMPONENT. It reads through `src/lib/racingNavigationRead.ts`
 * (SELECT-only) and renders plain data. No `'use client'`, no browser
 * Supabase client, no service-role value in any prop, no provider call, no
 * model run, no odds capture, no lock and no settlement. Rendering this page
 * writes nothing.
 *
 * An EMPTY date is a normal outcome and renders an empty state, not an error.
 * A MALFORMED or IMPOSSIBLE date is `notFound()` — it is never normalised into
 * a neighbouring day.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';

import AppShell from '@/components/AppShell';
import { EmptyState, ErrorState, SectionHeader } from '@/components/UiPrimitives';
import Breadcrumbs from '@/components/racing/Breadcrumbs';
import MeetingSummaryCard from '@/components/racing/MeetingSummaryCard';
import {
  canonicalDateHref,
  datePageTitle,
  decodeRouteSegment,
  formatMeetingDate,
  groupRacesByMeeting,
  isCanonicalDate,
  nextMeetingDate,
  previousMeetingDate,
  summariseStoredStatuses,
} from '@/lib/racingNavigation';
import { loadRacesForDate } from '@/lib/racingNavigationRead';

interface DatePageProps {
  params: Promise<{ date: string }>;
}

/** Validates the untrusted route segment, or null when it is not a real date. */
function readDateParam(raw: string): string | null {
  const decoded = decodeRouteSegment(raw);
  return decoded !== null && isCanonicalDate(decoded) ? decoded : null;
}

export async function generateMetadata({ params }: DatePageProps): Promise<Metadata> {
  const { date: raw } = await params;
  const date = readDateParam(raw);
  if (date === null) return { title: 'Racing date not found' };
  const title = datePageTitle(date) ?? 'Racing';
  return {
    title,
    description: `Stored racecards and meetings for ${formatMeetingDate(date)}. Decision-support analytics only.`,
  };
}

export default async function DatePage({ params }: DatePageProps) {
  const { date: raw } = await params;
  const date = readDateParam(raw);
  // Malformed or impossible dates are 404 — never silently normalised.
  if (date === null) notFound();

  const outcome = await loadRacesForDate(date);
  const longDate = formatMeetingDate(date) ?? date;
  const meetings = outcome.kind === 'ok' ? groupRacesByMeeting(outcome.races) : [];

  const previous = previousMeetingDate(date);
  const next = nextMeetingDate(date);
  const previousHref = previous === null ? null : canonicalDateHref(previous);
  const nextHref = next === null ? null : canonicalDateHref(next);

  return (
    <AppShell>
      <Breadcrumbs items={[{ label: 'Racing', href: '/' }, { label: longDate, href: null }]} />

      <header className="rb-page-header">
        <p className="rb-eyebrow">Race day</p>
        <h1 className="rb-page-title">Racing on {longDate}</h1>
      </header>

      <nav className="rb-daynav" aria-label="Adjacent race days">
        {previousHref !== null ? (
          <Link className="rb-inline-link" href={previousHref} rel="prev">
            &larr; {formatMeetingDate(previous) ?? previous}
          </Link>
        ) : (
          <span className="rb-meta">No earlier day</span>
        )}
        {nextHref !== null ? (
          <Link className="rb-inline-link" href={nextHref} rel="next">
            {formatMeetingDate(next) ?? next} &rarr;
          </Link>
        ) : (
          <span className="rb-meta">No later day</span>
        )}
      </nav>

      {outcome.kind === 'read_failed' ? (
        <ErrorState title="Race data could not be loaded" level={2}>
          The stored racecards for this date could not be read. Nothing was changed. Try again, or
          choose another date.
        </ErrorState>
      ) : outcome.races.length === 0 ? (
        <EmptyState title="No stored races for this date" level={2}>
          No racecard has been stored for {longDate}. This is not an error — a date only has
          meetings once its racecards have been ingested.
        </EmptyState>
      ) : (
        <>
          {/*
            HONEST STATUS INDICATOR. `races` carries no verified capture
            timestamp in this repository, so this reports the STORED status of
            the rows rather than asserting a freshness it cannot evidence. It
            never claims the page is "live".
          */}
          <section className="rb-panel" aria-label="What is recorded for this date">
            <SectionHeader
              level={2}
              eyebrow="Stored data"
              title="What is recorded for this date"
              description="Counts come from the stored racecard rows. No live status is implied, and no capture timestamp is recorded for racecards."
            />
            <ul className="rb-list">
              <li>
                {outcome.races.length} race{outcome.races.length === 1 ? '' : 's'} stored across{' '}
                {meetings.length} meeting{meetings.length === 1 ? '' : 's'}
              </li>
              {summariseStoredStatuses(outcome.races).map((entry) => (
                <li key={entry.label}>
                  {entry.label}: <span className="rb-tabular">{entry.count}</span>
                </li>
              ))}
            </ul>
          </section>

          <section aria-label="Meetings">
            <SectionHeader level={2} title="Meetings" />
            <div className="rb-meeting-grid">
              {meetings.map((meeting) => (
                <MeetingSummaryCard
                  key={meeting.courseKey ?? `historical-${meeting.courseLabel}`}
                  meeting={meeting}
                  date={date}
                />
              ))}
            </div>
          </section>
        </>
      )}
    </AppShell>
  );
}
