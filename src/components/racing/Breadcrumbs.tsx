/**
 * Accessible breadcrumb trail for the canonical racing routes.
 *
 * SERVER COMPONENT. No `'use client'`, no hooks, no state, no data fetching.
 *
 * Semantics: a `<nav aria-label="Breadcrumb">` wrapping an ordered list, with
 * the final crumb marked `aria-current="page"` and rendered as text rather
 * than a link — a link to the page you are on is a keyboard trap for no gain.
 * Separators are decorative and `aria-hidden`, so a screen reader announces
 * the trail rather than a run of slashes.
 *
 * Every href is supplied by the caller from a stored canonical handle. This
 * component builds no route of its own.
 */

import Link from 'next/link';

export interface Crumb {
  label: string;
  /** Canonical href, or null for the current page (the last crumb). */
  href: string | null;
}

export interface BreadcrumbsProps {
  items: readonly Crumb[];
}

export function Breadcrumbs({ items }: BreadcrumbsProps) {
  if (items.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className="rb-crumbs">
      <ol className="rb-crumbs__list">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li className="rb-crumbs__item" key={`${item.label}-${index}`}>
              {item.href !== null && !isLast ? (
                <Link className="rb-inline-link" href={item.href}>
                  {item.label}
                </Link>
              ) : (
                <span aria-current={isLast ? 'page' : undefined}>{item.label}</span>
              )}
              {!isLast && (
                <span className="rb-crumbs__sep" aria-hidden="true">
                  /
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export default Breadcrumbs;
