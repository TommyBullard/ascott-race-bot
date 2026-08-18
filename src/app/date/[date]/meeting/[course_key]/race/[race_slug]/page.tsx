/**
 * Canonical race page —
 * `/date/[date]/meeting/[course_key]/race/[race_slug]`.
 *
 * Resolves ONE race by the exact stored tuple (`meeting_date`, `course_key`,
 * `race_slug`) and renders its stored card plus its declared field.
 *
 * IDENTITY. The slug is never recomputed from current race data, and the
 * internal `races.id` never appears in the public path — it is used only to
 * load runners. Adjacent-race links are built from neighbours' STORED slugs.
 *
 * AMBIGUITY. The database does not yet enforce uniqueness on the canonical
 * tuple, so a duplicate is possible. This page NEVER picks one: it fails
 * closed with a safe message that names no internal identifier.
 *
 * SEPARATION. Everything rendered here is stored racecard data. There is no
 * odds, model, probability or recommendation content on this page, and the
 * page says so explicitly rather than leaving a reader to assume currency.
 * Rendering triggers no model run and no odds capture.
 *
 * SERVER COMPONENT. SELECT-only reads, no service-role value in any prop.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';

import AppShell from '@/components/AppShell';
import { ErrorState, SectionHeader, UnavailableState } from '@/components/UiPrimitives';
import Breadcrumbs from '@/components/racing/Breadcrumbs';
import RunnerList from '@/components/racing/RunnerList';
import {
  canonicalDateHref,
  canonicalMeetingHref,
  decodeRouteSegment,
  describeRaceStatus,
  displayDistance,
  displayValue,
  findAdjacentRaces,
  formatMeetingDate,
  formatOffTime,
  groupRacesByMeeting,
  isCanonicalDate,
  isCanonicalHandle,
  racePageTitle,
  UNAVAILABLE_LABEL,
} from '@/lib/racingNavigation';
import { loadMeeting, loadRunnersForRace, resolveCanonicalRace } from '@/lib/racingNavigationRead';

interface RacePageProps {
  params: Promise<{ date: string; course_key: string; race_slug: string }>;
}

interface ParsedParams {
  date: string;
  courseKey: string;
  raceSlug: string;
}

/** Validates all three untrusted route segments together. */
function readParams(rawDate: string, rawKey: string, rawSlug: string): ParsedParams | null {
  const date = decodeRouteSegment(rawDate);
  const courseKey = decodeRouteSegment(rawKey);
  const raceSlug = decodeRouteSegment(rawSlug);
  if (date === null || courseKey === null || raceSlug === null) return null;
  if (!isCanonicalDate(date) || !isCanonicalHandle(courseKey) || !isCanonicalHandle(raceSlug)) {
    return null;
  }
  return { date, courseKey, raceSlug };
}

export async function generateMetadata({ params }: RacePageProps): Promise<Metadata> {
  const { date: rawDate, course_key: rawKey, race_slug: rawSlug } = await params;
  const parsed = readParams(rawDate, rawKey, rawSlug);
  if (parsed === null) return { title: 'Race not found' };

  const resolution = await resolveCanonicalRace(parsed.date, parsed.courseKey, parsed.raceSlug);
  if (resolution.kind !== 'ok') return { title: 'Race not found' };

  const courseLabel =
    typeof resolution.race.course === 'string' && resolution.race.course.trim() !== ''
      ? resolution.race.course.trim()
      : parsed.courseKey;

  return {
    title: racePageTitle(resolution.race, courseLabel),
    description: `Stored racecard and declared field for this race at ${courseLabel} on ${formatMeetingDate(parsed.date)}. Decision-support analytics only.`,
  };
}

export default async function RacePage({ params }: RacePageProps) {
  const { date: rawDate, course_key: rawKey, race_slug: rawSlug } = await params;
  const parsed = readParams(rawDate, rawKey, rawSlug);
  if (parsed === null) notFound();

  const { date, courseKey, raceSlug } = parsed;
  const longDate = formatMeetingDate(date) ?? date;
  const dateHref = canonicalDateHref(date);
  const meetingHref = canonicalMeetingHref(date, courseKey);

  const resolution = await resolveCanonicalRace(date, courseKey, raceSlug);

  if (resolution.kind === 'not_found') notFound();

  if (resolution.kind === 'read_failed' || resolution.kind === 'ambiguous') {
    // FAIL CLOSED. Neither branch selects a row, and neither message contains a
    // uuid, a slug, a course label or any database error text.
    return (
      <AppShell>
        <Breadcrumbs
          items={[
            { label: 'Racing', href: '/' },
            { label: longDate, href: dateHref },
            { label: courseKey, href: meetingHref },
            { label: 'Race', href: null },
          ]}
        />
        <header className="rb-page-header">
          <h1 className="rb-page-title">Race unavailable</h1>
        </header>
        {resolution.kind === 'ambiguous' ? (
          <ErrorState
            title="This race cannot be shown safely"
            level={2}
            detail="No race has been selected, and nothing was changed."
          >
            More than one stored race matches this address, so showing one of them could show the
            wrong race. This has been recorded for review. Please use the meeting page to reach the
            race you want.
          </ErrorState>
        ) : (
          <ErrorState title="Race could not be loaded" level={2}>
            The stored racecard for this race could not be read. Nothing was changed.
          </ErrorState>
        )}
      </AppShell>
    );
  }

  const race = resolution.race;
  const courseLabel =
    typeof race.course === 'string' && race.course.trim() !== '' ? race.course.trim() : courseKey;
  const offTime = formatOffTime(race.off_time);
  const status = describeRaceStatus(race);
  const raceName =
    typeof race.race_name === 'string' && race.race_name.trim() !== ''
      ? race.race_name.trim()
      : UNAVAILABLE_LABEL;

  // Runners are loaded by the RESOLVED INTERNAL uuid — never by the slug, and
  // the uuid is not rendered anywhere on the page.
  const runnersOutcome = await loadRunnersForRace(race.id);

  // Adjacent races come from the same stored meeting, ordered canonically.
  const meetingOutcome = await loadMeeting(date, courseKey);
  const adjacent =
    meetingOutcome.kind === 'ok'
      ? findAdjacentRaces(meetingOutcome.races, race.id)
      : { previous: null, next: null };
  const meetingLabel =
    meetingOutcome.kind === 'ok'
      ? groupRacesByMeeting(meetingOutcome.races)[0]?.courseLabel ?? courseLabel
      : courseLabel;

  const cardFacts: { label: string; value: string }[] = [
    { label: 'Scheduled off', value: offTime ?? UNAVAILABLE_LABEL },
    { label: 'Status', value: status.label },
    { label: 'Race type', value: displayValue(race.race_type) },
    { label: 'Distance', value: displayDistance(race) },
    { label: 'Going', value: displayValue(race.going) },
    { label: 'Class', value: displayValue(race.race_class) },
    { label: 'Age band', value: displayValue(race.age_band) },
    { label: 'Pattern', value: displayValue(race.pattern) },
    { label: 'Declared field size', value: displayValue(race.field_size) },
    { label: 'Abandoned', value: displayValue(race.is_abandoned) },
    { label: 'Country', value: displayValue(race.country) },
  ];

  return (
    <AppShell>
      <Breadcrumbs
        items={[
          { label: 'Racing', href: '/' },
          { label: longDate, href: dateHref },
          { label: meetingLabel, href: meetingHref },
          { label: offTime ? `${offTime} ${raceName}` : raceName, href: null },
        ]}
      />

      <header className="rb-page-header">
        <p className="rb-eyebrow">Race</p>
        <h1 className="rb-page-title">
          {offTime ? `${offTime} ` : ''}
          {raceName}
        </h1>
        <p className="rb-meta">
          {meetingLabel} · {longDate}
          {offTime ? ` · scheduled off ${offTime}` : ''}
        </p>
      </header>

      <section className="rb-panel" aria-label="Stored race information">
        <SectionHeader
          level={2}
          eyebrow="Stored racecard"
          title="Race information"
          description="Every value below is a stored racecard field. Blank fields read “Not recorded”, which is different from a recorded value of zero."
        />
        <dl className="rb-race-facts">
          {cardFacts.map((fact) => (
            <div className="rb-race-facts__item" key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-label="Declared field">
        <SectionHeader
          level={2}
          eyebrow="Stored racecard"
          title="Declared field"
          description="The runners as declared on the stored card. No odds, probability or selection is shown here."
        />
        {runnersOutcome.kind === 'read_failed' ? (
          <ErrorState title="Runners could not be loaded" level={3}>
            The declared field for this race could not be read. Nothing was changed.
          </ErrorState>
        ) : (
          <RunnerList
            runners={runnersOutcome.runners}
            caption={`Declared field for ${raceName} at ${meetingLabel} on ${longDate}`}
          />
        )}
      </section>

      {/*
        MARKET AND MODEL ARE DELIBERATELY SEPARATE AND DELIBERATELY ABSENT.
        This page reads racecard rows only. Rather than leave a reader to guess
        whether the silence means "no value" or "not loaded", it states the
        boundary — and it can never imply currency, because it loads no odds or
        model record and no timestamp for one.
      */}
      <section aria-label="Market and model information">
        <UnavailableState title="Market and model information" level={2}>
          This page shows stored racecard data only. Odds and model output are not loaded here, so
          nothing on this page reflects a current market price or a current model view.
        </UnavailableState>
      </section>

      <nav className="rb-daynav" aria-label="Adjacent races at this meeting">
        {adjacent.previous !== null ? (
          <Link className="rb-inline-link" href={adjacent.previous.href} rel="prev">
            &larr; {adjacent.previous.label}
          </Link>
        ) : (
          <span className="rb-meta">No earlier race</span>
        )}
        {adjacent.next !== null ? (
          <Link className="rb-inline-link" href={adjacent.next.href} rel="next">
            {adjacent.next.label} &rarr;
          </Link>
        ) : (
          <span className="rb-meta">No later race</span>
        )}
      </nav>

      {meetingHref !== null && (
        <p className="rb-note">
          <Link className="rb-inline-link" href={meetingHref}>
            &larr; All races at {meetingLabel}
          </Link>
        </p>
      )}
    </AppShell>
  );
}
