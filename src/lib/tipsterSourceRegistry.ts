/**
 * Compliant tipster SOURCE REGISTRY (pure core).
 *
 * Holds the canonical tipster universe — the strict-PDF CORE ACTIVE POOL, the
 * wider watchlist, per-source ACCESS CLASS, correlation groups, and seed
 * weights/priors — that gate which sources may ever feed model-active consensus.
 *
 * COMPLIANCE INVARIANTS (enforced by construction + tests):
 *   - NO SCRAPING / NO PAYWALL BYPASS. This module never fetches a URL. Paid /
 *     login sources (`paid_login`, `login_unknown`, `licensed`, `self_hosted_seller`)
 *     are flagged non-auto-acquirable: they can only be made current-selection
 *     active when the OPERATOR supplies permitted/manual selections.
 *   - NO FABRICATION. Seed rows carry the documented NAMES + structure only;
 *     evidence numbers (ROI / strike / sample) are left BLANK for the operator to
 *     fill from the verified research documents — never invented here.
 *   - CORRELATION CAP. The PR family (The Profit Rocket / UNDERDOG Racing Tips /
 *     ACTIVE Betting Hub) is never counted as independent votes; consensus uses a
 *     single family representative and the rest are diagnostic/shadow.
 *   - SYNTHETIC ≠ REAL. "What Would Jon Vine Do" is `synthetic_shadow_only`.
 *   - Nothing here changes model probability, EV, staking, ranking, or
 *     recommendations, and nothing places a bet.
 */

/* -------------------------------------------------------------------------- */
/* Access class                                                               */
/* -------------------------------------------------------------------------- */

export type SourceAccessClass =
  | 'public_free'
  | 'paid_login'
  | 'login_unknown'
  | 'licensed'
  | 'self_hosted_seller'
  | 'media_public'
  | 'synthetic_shadow_only';

export const SOURCE_ACCESS_CLASSES: readonly SourceAccessClass[] = [
  'public_free',
  'paid_login',
  'login_unknown',
  'licensed',
  'self_hosted_seller',
  'media_public',
  'synthetic_shadow_only',
];

/**
 * Access classes whose current picks may NEVER be auto-acquired (no scraping, no
 * paywall bypass). They can only become current-selection active via operator-
 * supplied / manually-entered, permitted selections.
 */
export const NON_AUTO_ACQUIRABLE_CLASSES: readonly SourceAccessClass[] = [
  'paid_login',
  'login_unknown',
  'licensed',
  'self_hosted_seller',
  'synthetic_shadow_only',
];

/**
 * Whether a source's current picks could ever be auto-acquired from a free,
 * public, non-login page. NOTE: this system never actually fetches anything — it
 * reads LOCAL operator notes only — so this is a classification helper. Pure.
 */
export function accessClassAllowsAutoAcquire(cls: SourceAccessClass): boolean {
  return cls === 'public_free' || cls === 'media_public';
}

/** True for paid / login-gated classes that must not be scraped. Pure. */
export function isPaidOrLoginClass(cls: SourceAccessClass): boolean {
  return cls === 'paid_login' || cls === 'login_unknown';
}

/* -------------------------------------------------------------------------- */
/* Canonical universe (from the strict PDF + research brief)                  */
/* -------------------------------------------------------------------------- */

/** The strict-PDF CORE ACTIVE POOL (higher-priority correction layer). */
export const CORE_ACTIVE_POOL: readonly string[] = [
  'the king of horses',
  'On Target Tips',
  'LIVE FOR RACING',
  'PRO EACHWAY MORNING',
  'The Profit Rocket',
  'Knottlast',
  'iontheball',
  'ryanwe',
  'UncleFiddler',
  'Edwinp',
];

/**
 * The wider watchlist preserved from the research brief (partial — fill from the
 * verified documents). Named subscription walls are watchlist-only and never
 * current-selection active without operator-supplied permitted selections.
 */
export const WATCHLIST: readonly string[] = [
  'UNDERDOG Racing Tips',
  'ACTIVE Betting Hub',
  'Racing Post',
  'Tipstrr',
  'Betting Gods',
  'Tipsters Empire',
];

/* -------------------------------------------------------------------------- */
/* Correlation groups                                                         */
/* -------------------------------------------------------------------------- */

/** A correlation group: members that must not be counted as independent votes. */
export interface CorrelationGroup {
  group: string;
  members: readonly string[];
  /** The single member used for model-active consensus when several are present. */
  representative: string;
}

/** The PR family — one shared signal, never three independent votes. */
export const PR_FAMILY: CorrelationGroup = {
  group: 'PR family',
  members: ['The Profit Rocket', 'UNDERDOG Racing Tips', 'ACTIVE Betting Hub'],
  representative: 'The Profit Rocket',
};

export const CORRELATION_GROUPS: readonly CorrelationGroup[] = [PR_FAMILY];

function norm(s: string): string {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Finds the correlation group a tipster/source name belongs to, or null. Pure. */
export function correlationGroupOf(name: string): CorrelationGroup | null {
  const hay = norm(name);
  if (hay === '') return null;
  for (const g of CORRELATION_GROUPS) {
    if (g.members.some((m) => hay.includes(norm(m)) || norm(m).includes(hay))) return g;
  }
  return null;
}

/** The canonical family member a name maps to (for de-duplication), or null. Pure. */
export function correlationMemberOf(name: string): string | null {
  const hay = norm(name);
  for (const g of CORRELATION_GROUPS) {
    for (const m of g.members) {
      if (hay.includes(norm(m)) || norm(m).includes(hay)) return m;
    }
  }
  return null;
}

/** True when `name` is its family's representative. Pure. */
export function isFamilyRepresentative(name: string): boolean {
  const g = correlationGroupOf(name);
  if (!g) return false;
  return norm(name).includes(norm(g.representative)) || norm(g.representative).includes(norm(name));
}

/* -------------------------------------------------------------------------- */
/* Registry rows + CSV                                                        */
/* -------------------------------------------------------------------------- */

export type RegistryReviewStatus = 'pending' | 'approved' | 'rejected';

/** The source-registry CSV column order. */
export const REGISTRY_COLUMNS = [
  'source_label',
  'tipster_name',
  'source_url',
  'proof_url',
  'evidence_type',
  'long_run_roi',
  'recent_roi',
  'sample_size',
  'strike_rate',
  'profit_points',
  'drawdown_or_losing_run',
  'current_pick_access',
  'correlation_group',
  'model_weight',
  'evidence_confidence',
  'source_access_class',
  'review_status',
  'notes',
] as const;

/** One source-registry row. Evidence numbers stay strings (blank = unknown). */
export interface SourceRegistryRow {
  source_label: string;
  tipster_name: string;
  source_url: string;
  proof_url: string;
  evidence_type: string;
  long_run_roi: string;
  recent_roi: string;
  sample_size: string;
  strike_rate: string;
  profit_points: string;
  drawdown_or_losing_run: string;
  current_pick_access: string;
  correlation_group: string;
  model_weight: string;
  evidence_confidence: string;
  source_access_class: SourceAccessClass;
  review_status: RegistryReviewStatus;
  notes: string;
}

function asAccessClass(value: string): SourceAccessClass {
  const v = norm(value).replace(/\s+/g, '_') as SourceAccessClass;
  return SOURCE_ACCESS_CLASSES.includes(v) ? v : 'login_unknown';
}
function asRegReview(value: string): RegistryReviewStatus {
  const v = norm(value);
  return v === 'approved' || v === 'rejected' ? (v as RegistryReviewStatus) : 'pending';
}

/* RFC 4180 parse/serialize (pure) */
function parseCsvGrid(text: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      started = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
      started = true;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (started || field !== '' || row.length > 0) {
        row.push(field);
        records.push(row);
      }
      field = '';
      row = [];
      started = false;
    } else {
      field += c;
      started = true;
    }
  }
  if (started || field !== '' || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  return records;
}

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Parses registry CSV text into typed rows. Pure; lenient; never throws. */
export function parseRegistryCsv(text: string): SourceRegistryRow[] {
  const grid = parseCsvGrid(text);
  if (grid.length === 0) return [];
  const header = grid[0].map((h) => h.trim());
  return grid.slice(1).map((cells) => {
    const rec: Record<string, string> = {};
    header.forEach((h, i) => {
      rec[h] = (cells[i] ?? '').trim();
    });
    return {
      source_label: rec.source_label ?? '',
      tipster_name: rec.tipster_name ?? '',
      source_url: rec.source_url ?? '',
      proof_url: rec.proof_url ?? '',
      evidence_type: rec.evidence_type ?? '',
      long_run_roi: rec.long_run_roi ?? '',
      recent_roi: rec.recent_roi ?? '',
      sample_size: rec.sample_size ?? '',
      strike_rate: rec.strike_rate ?? '',
      profit_points: rec.profit_points ?? '',
      drawdown_or_losing_run: rec.drawdown_or_losing_run ?? '',
      current_pick_access: rec.current_pick_access ?? '',
      correlation_group: rec.correlation_group ?? '',
      model_weight: rec.model_weight ?? '',
      evidence_confidence: rec.evidence_confidence ?? '',
      source_access_class: asAccessClass(rec.source_access_class ?? ''),
      review_status: asRegReview(rec.review_status ?? ''),
      notes: rec.notes ?? '',
    };
  });
}

/** Serialises registry rows to CSV text. Pure. */
export function serializeRegistryCsv(rows: readonly SourceRegistryRow[]): string {
  const lines = [REGISTRY_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(REGISTRY_COLUMNS.map((c) => csvCell(String(r[c] ?? ''))).join(','));
  }
  return lines.join('\n') + '\n';
}

/* -------------------------------------------------------------------------- */
/* Seed builder (names + structure only — NO fabricated numbers)              */
/* -------------------------------------------------------------------------- */

/** A blank registry row with safe defaults (no fabricated evidence numbers). */
function seedRow(over: Partial<SourceRegistryRow>): SourceRegistryRow {
  return {
    source_label: '',
    tipster_name: '',
    source_url: '',
    proof_url: '',
    evidence_type: '',
    long_run_roi: '',
    recent_roi: '',
    sample_size: '',
    strike_rate: '',
    profit_points: '',
    drawdown_or_losing_run: '',
    current_pick_access: '',
    correlation_group: '',
    model_weight: '', // BLANK — seed from the verified documents, never invented
    evidence_confidence: 'unknown',
    source_access_class: 'login_unknown',
    review_status: 'pending',
    notes: '',
    ...over,
  };
}

/**
 * Builds the seed registry from the documented universe: the core active pool
 * (PR-family-tagged where relevant), the wider watchlist (named subscription
 * walls as `paid_login`, never current-selection active), and the synthetic
 * Jon Vine strategy profile. Evidence numbers are left BLANK — fill them from
 * the verified research documents. Pure; deterministic.
 */
export function buildRegistrySeedRows(): SourceRegistryRow[] {
  const rows: SourceRegistryRow[] = [];

  for (const name of CORE_ACTIVE_POOL) {
    const group = correlationGroupOf(name);
    rows.push(
      seedRow({
        source_label: name,
        tipster_name: name,
        correlation_group: group?.group ?? '',
        source_access_class: 'login_unknown',
        notes:
          'Strict-PDF core active pool. Fill ROI/strike/sample/proof from the verified documents; ' +
          'confirm access class + permitted current-pick source before approval.',
      }),
    );
  }

  // PR-family non-core members: diagnostic/shadow (capped to the representative).
  for (const name of ['UNDERDOG Racing Tips', 'ACTIVE Betting Hub']) {
    rows.push(
      seedRow({
        source_label: name,
        tipster_name: name,
        correlation_group: PR_FAMILY.group,
        source_access_class: 'login_unknown',
        review_status: 'pending',
        notes: `PR family (correlated with ${PR_FAMILY.representative}) — diagnostic/shadow only; capped to the family representative for consensus.`,
      }),
    );
  }

  // Named subscription walls: watchlist only, never auto-acquired.
  for (const name of ['Racing Post', 'Tipstrr', 'Betting Gods', 'Tipsters Empire']) {
    rows.push(
      seedRow({
        source_label: name,
        tipster_name: name,
        source_access_class: 'paid_login',
        current_pick_access: 'paid_login',
        notes: 'Subscription / login wall — NEVER scraped. Current-selection active only via operator-supplied, permitted/manual selections.',
      }),
    );
  }

  // Synthetic strategy profile.
  rows.push(
    seedRow({
      source_label: 'What Would Jon Vine Do',
      tipster_name: 'Jon Vine Strategy (synthetic)',
      source_access_class: 'synthetic_shadow_only',
      correlation_group: '',
      notes: 'Synthetic strategy heuristic — shadow-only until backtested; never a real sourced tipster without permitted, evidenced tips.',
    }),
  );

  return rows;
}

/** True when a registry row may ever be current-selection active. Pure. */
export function registryRowCurrentSelectionEligible(row: SourceRegistryRow): boolean {
  if (row.source_access_class === 'synthetic_shadow_only') return false;
  if (row.review_status !== 'approved') return false;
  // Paid/login/licensed/self-hosted may only be active via operator-supplied
  // selections — the registry alone never makes them auto-active.
  return true;
}
