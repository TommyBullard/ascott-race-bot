/**
 * Racing Bot shared read-only UI primitives.
 *
 * SLICE 1 SCOPE. Presentational building blocks for the multi-course rebuild.
 * Every primitive here is a SERVER component: no `'use client'`, no hooks, no
 * state, no effects, no fetch, no browser storage, no environment access, and
 * no write controls of any kind (no form, no button, no submit handler).
 *
 * These primitives carry NO domain meaning. They never label evidence as
 * official or diagnostic on their own — the caller supplies that wording — so
 * they cannot conflate the locked-decision record with live model diagnostics,
 * market data, ML shadow output, tipster evidence or GenAI commentary.
 *
 * Accessibility contract:
 *   - Status is never communicated by colour alone. Every `StatusBadge`
 *     renders a glyph AND a required visible text label.
 *   - Loading skeletons hide their decorative bars from assistive technology
 *     and expose a text message instead.
 *   - Headings are real heading elements at a caller-chosen level.
 *
 * Decision-support only. Nothing here places, recommends or settles a bet.
 */

import { createElement, type ReactNode } from 'react';

/** Joins class names, skipping anything empty. */
function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** Heading levels these primitives may render. */
export type HeadingLevel = 2 | 3 | 4;

/**
 * Maps a level to a heading tag by explicit enumeration rather than string
 * interpolation. React does not sanitise element type strings, so a total
 * function here means an out-of-contract `level` can never become an arbitrary
 * tag name — it degrades to `h3`.
 */
function headingTag(level: HeadingLevel): 'h2' | 'h3' | 'h4' {
  if (level === 2) return 'h2';
  if (level === 4) return 'h4';
  return 'h3';
}

/**
 * Renders a heading at a caller-chosen level.
 *
 * Built with `createElement` rather than a capitalised local variable: the tag
 * is an intrinsic element name, and assigning it to a `<Heading />` variable
 * would declare a new component on every render.
 */
function heading(
  level: HeadingLevel,
  className: string,
  ...children: ReactNode[]
): ReactNode {
  return createElement(headingTag(level), { className }, ...children);
}

/* ========================================================================== *
 * VisuallyHidden
 * ========================================================================== */

export interface VisuallyHiddenProps {
  children: ReactNode;
  className?: string;
}

/** Text available to assistive technology but not shown on screen. */
export function VisuallyHidden({ children, className }: VisuallyHiddenProps) {
  return <span className={cx('rb-visually-hidden', className)}>{children}</span>;
}

/* ========================================================================== *
 * Surfaces
 * ========================================================================== */

export interface SurfaceProps {
  children: ReactNode;
  className?: string;
  /** Accessible name, when the surface should be an addressable region. */
  ariaLabel?: string;
}

/**
 * Raised analytical surface for a major page region.
 * Renders a `<section>` so it is a real document section.
 */
export function NeumorphicPanel({ children, className, ariaLabel }: SurfaceProps) {
  return (
    <section className={cx('rb-panel', className)} aria-label={ariaLabel}>
      {children}
    </section>
  );
}

/**
 * Self-contained analytical unit inside a panel.
 * Renders an `<article>`: a card is independently meaningful content.
 */
export function AnalyticalCard({ children, className, ariaLabel }: SurfaceProps) {
  return (
    <article className={cx('rb-card', className)} aria-label={ariaLabel}>
      {children}
    </article>
  );
}

/* ========================================================================== *
 * SectionHeader
 * ========================================================================== */

export interface SectionHeaderProps {
  /** Heading text. */
  title: ReactNode;
  /** Short uppercase category above the title. */
  eyebrow?: ReactNode;
  /** One-line explanation below the title. */
  description?: ReactNode;
  /** Heading level, so callers keep a correct document outline. */
  level?: HeadingLevel;
  className?: string;
}

export function SectionHeader({
  title,
  eyebrow,
  description,
  level = 2,
  className,
}: SectionHeaderProps) {
  return (
    <header className={cx('rb-section-header', className)}>
      {eyebrow ? <span className="rb-section-header__eyebrow">{eyebrow}</span> : null}
      {heading(level, 'rb-section-header__title', title)}
      {description ? <p className="rb-section-header__description">{description}</p> : null}
    </header>
  );
}

/* ========================================================================== *
 * StatusBadge
 * ========================================================================== */

/**
 * Visual tone. Tone sets colour only — it never carries meaning by itself.
 * The caller's visible text is what states the status.
 */
export type StatusTone = 'neutral' | 'analytical' | 'positive' | 'warning' | 'failure' | 'official';

/**
 * Non-colour glyphs. These make every tone distinguishable in greyscale, for
 * colour-blind readers, and on a monochrome display.
 */
export const STATUS_TONE_GLYPHS: Record<StatusTone, string> = {
  neutral: '–',
  analytical: '◆',
  positive: '✓',
  warning: '!',
  failure: '×',
  official: '◼',
};

export interface StatusBadgeProps {
  /** REQUIRED visible label. A badge is never glyph- or colour-only. */
  children: ReactNode;
  tone?: StatusTone;
  /** Extra context announced before the visible label. */
  srLabel?: string;
  className?: string;
}

export function StatusBadge({
  children,
  tone = 'neutral',
  srLabel,
  className,
}: StatusBadgeProps) {
  return (
    <span className={cx('rb-badge', `rb-badge--${tone}`, className)}>
      <span className="rb-badge__glyph" aria-hidden="true">
        {STATUS_TONE_GLYPHS[tone]}
      </span>
      {srLabel ? <VisuallyHidden>{srLabel}</VisuallyHidden> : null}
      <span className="rb-badge__text">{children}</span>
    </span>
  );
}

/* ========================================================================== *
 * MetricTile
 * ========================================================================== */

export interface MetricTileProps {
  /** What is being measured. */
  label: ReactNode;
  /** The measurement. Pass a dash or an explicit phrase when not recorded. */
  value: ReactNode;
  /** Qualifier such as the sample size or the source of the figure. */
  note?: ReactNode;
  className?: string;
}

/**
 * A single labelled figure.
 *
 * Uses a description list so the label/value relationship is expressed in the
 * markup, not just visually. Figures are set in tabular numerals so columns of
 * tiles align.
 */
export function MetricTile({ label, value, note, className }: MetricTileProps) {
  return (
    <div className={cx('rb-metric', className)}>
      <dl className="rb-metric__pair">
        <dt className="rb-metric__label">{label}</dt>
        <dd className="rb-metric__value rb-tabular">{value}</dd>
      </dl>
      {note ? <p className="rb-metric__note">{note}</p> : null}
    </div>
  );
}

/* ========================================================================== *
 * Message states
 * ========================================================================== */

interface MessageStateProps {
  title: ReactNode;
  children: ReactNode;
  /** Secondary line, such as a reason code or the scope that was searched. */
  detail?: ReactNode;
  level?: HeadingLevel;
  className?: string;
}

/** Shared frame for the empty / unavailable / error states. */
function MessageState({
  title,
  children,
  detail,
  level = 3,
  className,
  variant,
  glyph,
  role,
}: MessageStateProps & {
  variant: 'empty' | 'unavailable' | 'error';
  glyph: string;
  role?: 'alert';
}) {
  return (
    <section className={cx('rb-state', `rb-state--${variant}`, className)} role={role}>
      {heading(
        level,
        'rb-state__heading',
        <span className="rb-state__glyph" aria-hidden="true" key="glyph">
          {glyph}
        </span>,
        title
      )}
      <p className="rb-state__body">{children}</p>
      {detail ? <p className="rb-state__detail">{detail}</p> : null}
    </section>
  );
}

/**
 * Nothing matched the current scope, and that is a normal outcome.
 * Say what was looked for and what would change the result.
 */
export function EmptyState({ title, children, detail, level, className }: MessageStateProps) {
  return (
    <MessageState
      variant="empty"
      glyph="○"
      title={title}
      detail={detail}
      level={level}
      className={className}
    >
      {children}
    </MessageState>
  );
}

/**
 * A figure or record exists in principle but is not available here — not
 * recorded, not yet captured, or below the evidence threshold. Never render a
 * fabricated value in its place.
 */
export function UnavailableState({
  title,
  children,
  detail,
  level,
  className,
}: MessageStateProps) {
  return (
    <MessageState
      variant="unavailable"
      glyph="⊘"
      title={title}
      detail={detail}
      level={level}
      className={className}
    >
      {children}
    </MessageState>
  );
}

/**
 * Something failed. State what went wrong and what to do next; the message is
 * announced immediately via `role="alert"`.
 */
export function ErrorState({ title, children, detail, level, className }: MessageStateProps) {
  return (
    <MessageState
      variant="error"
      glyph="×"
      role="alert"
      title={title}
      detail={detail}
      level={level}
      className={className}
    >
      {children}
    </MessageState>
  );
}

/* ========================================================================== *
 * LoadingSkeleton
 * ========================================================================== */

/** Bars rendered when no usable count is given. */
export const DEFAULT_SKELETON_LINES = 3;

export interface LoadingSkeletonProps {
  /** Number of placeholder bars. */
  lines?: number;
  /** Message announced while loading. */
  label?: string;
  className?: string;
}

/**
 * Placeholder shown while content loads.
 *
 * The bars are decoration and are hidden from assistive technology; the
 * status message is what a screen reader announces. The pulse animation is
 * disabled under a reduced-motion preference (see `tokens.css`).
 *
 * `lines` is normalised rather than trusted. A count derived from data —
 * `items.length` on an absent list, a parsed figure, a division by zero — can
 * arrive as NaN or Infinity even where the type says `number`, and both would
 * otherwise render an empty container: a silent blank region instead of a
 * loading state. Non-finite input falls back to `DEFAULT_SKELETON_LINES`, and
 * zero or negative still yields one visible bar.
 */
export function LoadingSkeleton({
  lines = DEFAULT_SKELETON_LINES,
  label = 'Loading',
  className,
}: LoadingSkeletonProps) {
  const count = Number.isFinite(lines)
    ? Math.max(1, Math.floor(lines))
    : DEFAULT_SKELETON_LINES;
  return (
    <div className={cx('rb-skeleton', className)} role="status">
      <VisuallyHidden>{label}</VisuallyHidden>
      {Array.from({ length: count }, (_, index) => (
        <span className="rb-skeleton__bar" key={index} aria-hidden="true" />
      ))}
    </div>
  );
}
