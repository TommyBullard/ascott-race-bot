/**
 * Public tipster DISCOVERY — COMPLIANCE PLANNER (pure, NO network).
 *
 * The safety rules forbid scraping paywalled / logged-in / ToS-prohibited pages,
 * and named commercial tipster sites (Racing Post, Tipstrr, Betting Gods,
 * Tipsters Empire, …) must never be fetched. Crucially, this module performs NO
 * network I/O at all: it does not fetch, scrape, or browse. It only:
 *
 *   - CLASSIFIES sources — hard-BLOCKING the subscription walls and flagging
 *     every other source as "operator must confirm ToS/robots + supply content."
 *   - ENFORCES short excerpts (never full copyrighted articles).
 *   - Provides the list of public/media seed sources to PLAN around.
 *
 * Actual content only ever enters the pipeline as operator-SUPPLIED, ToS-cleared
 * LOCAL excerpts (processed by the existing evidence-grounded extractor). Nothing
 * here is model-active, changes no model/staking math, and places no bet.
 */

import type { SourceAccessClass } from './tipsterSourceRegistry';

/** Max characters kept from any quoted source text (no full articles). */
export const MAX_EXCERPT_CHARS = 240;

/**
 * Subscription / login-walled hosts that must NEVER be fetched or scraped. Match
 * is host-substring based so subdomains and TLD variants are covered.
 */
export const SUBSCRIPTION_WALL_HOSTS: readonly string[] = [
  'racingpost.com',
  'racingpost.co.uk',
  'tipstrr.com',
  'bettinggods.com',
  'tipsempire',
  'tipsters-empire',
  'tipstersempire.com',
];

/** A public/media seed source to PLAN around (no auto-fetch; URL operator-supplied). */
export interface PublicSeedSource {
  label: string;
  access_class: SourceAccessClass;
  /** Whether real, evidenced current picks may be ingested from operator-supplied content. */
  ingestible: boolean;
  notes: string;
}

/**
 * The named public/media sources to consider — WITHOUT hardcoded scrape URLs.
 * The operator must confirm each source's robots.txt / ToS allows reuse and
 * supply the (short, attributable) content locally; this planner never fetches.
 */
export const PUBLIC_SEED_SOURCES: readonly PublicSeedSource[] = [
  { label: 'OLBG Royal Ascot public tips', access_class: 'media_public', ingestible: true, notes: 'Public media tips — confirm ToS/robots; supply short attributable excerpts locally.' },
  { label: 'HorseRacing.net public Royal Ascot tips', access_class: 'media_public', ingestible: true, notes: 'Public media tips — confirm ToS/robots; supply short excerpts locally.' },
  { label: 'Freetips public page', access_class: 'public_free', ingestible: true, notes: 'Free public page — confirm reuse is permitted; short excerpts only.' },
  { label: 'RacingInsider public page', access_class: 'public_free', ingestible: true, notes: 'Free public page — confirm reuse is permitted; short excerpts only.' },
  { label: 'Jon Vine public page', access_class: 'public_free', ingestible: true, notes: 'Ingest ONLY real, evidenced Jon Vine picks from a permitted public page. Never invent a "what would Jon Vine do" opinion.' },
  { label: 'Thatsagoal / Brian Healy public page', access_class: 'public_free', ingestible: true, notes: 'Public page — confirm reuse; short excerpts only.' },
  { label: 'Newspaper racing-tips roundup', access_class: 'media_public', ingestible: true, notes: 'Public, attributable roundup only — short excerpts; never full articles.' },
  { label: 'What Would Jon Vine Do', access_class: 'synthetic_shadow_only', ingestible: false, notes: 'Synthetic strategy heuristic — shadow-only until backtested; NEVER a real sourced tipster.' },
];

/** Extracts a lowercased host from a URL string, or '' when unparseable. Pure. */
export function extractHost(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    // Tolerate bare hosts / paths.
    const m = (url ?? '').toLowerCase().match(/^(?:[a-z]+:\/\/)?([^/\s]+)/);
    return m ? m[1] : '';
  }
}

/** True when a URL/host belongs to a subscription/login wall (never fetch). Pure. */
export function isSubscriptionWall(url: string): boolean {
  const host = extractHost(url);
  if (host === '') return false;
  return SUBSCRIPTION_WALL_HOSTS.some((w) => host.includes(w));
}

/** The compliance decision for a candidate source URL. */
export type SourceDecision = 'blocked_wall' | 'needs_operator_confirmation' | 'no_url';

/** One classified source. */
export interface SourceClassification {
  url: string;
  host: string;
  decision: SourceDecision;
  /** Whether this URL may EVER be a content source (false for walls). */
  permitted: boolean;
  reason: string;
}

/**
 * Classifies a candidate source URL. Subscription walls are BLOCKED outright;
 * everything else is `needs_operator_confirmation` — the operator must confirm
 * robots.txt / ToS permit reuse and supply short excerpts locally (this planner
 * never auto-fetches). Pure.
 */
export function classifySource(url: string): SourceClassification {
  const host = extractHost(url);
  if ((url ?? '').trim() === '') {
    return { url: '', host: '', decision: 'no_url', permitted: false, reason: 'no URL supplied' };
  }
  if (isSubscriptionWall(url)) {
    return {
      url,
      host,
      decision: 'blocked_wall',
      permitted: false,
      reason: 'subscription / login wall — never fetched or scraped',
    };
  }
  return {
    url,
    host,
    decision: 'needs_operator_confirmation',
    permitted: true,
    reason: 'public/other — operator must confirm robots.txt/ToS permits reuse and supply short excerpts locally (no auto-fetch)',
  };
}

/** Truncates quoted source text to a short, attributable excerpt. Pure. */
export function truncateExcerpt(text: string, max: number = MAX_EXCERPT_CHARS): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

/** A discovery plan: each candidate source's compliance decision. */
export interface DiscoveryPlan {
  classified: SourceClassification[];
  blockedWalls: number;
  permitted: number;
}

/** Builds a compliance plan for a set of candidate URLs. Pure; no network. */
export function buildDiscoveryPlan(urls: readonly string[]): DiscoveryPlan {
  const classified = urls.map(classifySource);
  return {
    classified,
    blockedWalls: classified.filter((c) => c.decision === 'blocked_wall').length,
    permitted: classified.filter((c) => c.permitted).length,
  };
}
