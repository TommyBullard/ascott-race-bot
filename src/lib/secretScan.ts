/**
 * Pure secret / local-artifact scanner for the launch security check
 * (scripts/securitySecretsCheck.ts).
 *
 * It classifies files and file CONTENT for secret material and risky launch
 * artifacts, and reports ONLY the file path, a rule id, and a risk level — it
 * NEVER returns, copies, or renders a matched secret value. The CLI feeds it the
 * tracked + untracked (non-ignored) files; git-ignored files (e.g. `.env.local`)
 * are never read, so their contents can never leak.
 *
 * Findings are downgraded to `info` on low-trust paths (tests / examples /
 * fixtures), and obvious placeholders (FAKE / EXAMPLE / short stubs) are skipped,
 * so the check fails only on REAL secret material in committable files. Pure +
 * deterministic; no I/O.
 */

export type RiskLevel = 'critical' | 'high' | 'info';

/** Whether a file is tracked by git, untracked (but not ignored), or ignored. */
export type FileStatus = 'tracked' | 'untracked' | 'ignored';

/** A single finding — path + rule + level only. NEVER carries a value. */
export interface SecretFinding {
  path: string;
  rule: string;
  description: string;
  level: RiskLevel;
  status: FileStatus;
  /** 1-based line for content findings; omitted for filename findings. */
  line?: number;
}

/** A content rule that detects secret material. */
interface ContentRule {
  id: string;
  description: string;
  regex: RegExp;
  level: RiskLevel;
  /** Capture group holding the candidate value (for placeholder checks). 0 = whole match. */
  valueGroup: number;
}

/** Sensitive environment variables whose ASSIGNED VALUE must never be committed. */
export const SENSITIVE_ENV_VARS = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'RACING_API_KEY',
  'RACING_API_USER',
  'BETFAIR_PASSWORD',
  'BETFAIR_USERNAME',
  'BETFAIR_APP_KEY',
  'BETFAIR_KEY_PEM',
  'BETFAIR_CERT_PEM',
  'CRON_SECRET',
  'OPENAI_API_KEY',
] as const;

const ENV_ASSIGNMENT_REGEX = new RegExp(
  `\\b(${SENSITIVE_ENV_VARS.join('|')})\\s*[:=]\\s*["']?([^\\s"'#]+)`,
);

/** Secret-material content rules. Ordered most-specific first. */
const CONTENT_RULES: readonly ContentRule[] = [
  {
    id: 'private_key',
    description: 'PEM private key block',
    regex: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
    level: 'critical',
    valueGroup: 0,
  },
  {
    id: 'certificate',
    description: 'PEM certificate block',
    // Built by concatenation so this scanner's own source can't self-match.
    regex: new RegExp('-----BEGIN ' + 'CERTIFICATE-----'),
    level: 'high',
    valueGroup: 0,
  },
  {
    id: 'openai_key',
    description: 'OpenAI-style sk- API key',
    regex: /\bsk-[A-Za-z0-9_-]{16,}/,
    level: 'critical',
    valueGroup: 0,
  },
  {
    id: 'jwt_token',
    description: 'JWT / Supabase legacy key',
    regex: /\beyJ[A-Za-z0-9_=-]{8,}\.[A-Za-z0-9_=-]{8,}\.[A-Za-z0-9_=-]{4,}/,
    level: 'high',
    valueGroup: 0,
  },
  {
    id: 'env_assignment',
    description: 'sensitive env var assigned a value',
    regex: ENV_ASSIGNMENT_REGEX,
    level: 'high',
    valueGroup: 2,
  },
  {
    id: 'bearer_token',
    description: 'bearer token with a value',
    regex: /\b[Bb]earer\s+["']?([A-Za-z0-9_.-]{12,})/,
    level: 'high',
    valueGroup: 1,
  },
];

/** Risky filenames that should never be committed (keys, certs, env dumps). */
interface FilenameRule {
  id: string;
  description: string;
  regex: RegExp;
  level: RiskLevel;
}

const FILENAME_RULES: readonly FilenameRule[] = [
  { id: 'private_key_file', description: 'private key / keystore file', regex: /\.(pem|key|p12|pfx|jks|keystore)$/i, level: 'critical' },
  { id: 'certificate_file', description: 'certificate / CSR file', regex: /\.(crt|cer|csr)$/i, level: 'high' },
  { id: 'ssh_key_file', description: 'SSH private key', regex: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, level: 'critical' },
  { id: 'env_dump_file', description: 'env / credential dump file', regex: /(^|\/)(betfair-(?:cert|key)-env|.*-secrets?|.*credentials?)\.txt$/i, level: 'high' },
  { id: 'client_cert_bundle', description: 'client cert/key bundle', regex: /(^|\/)client-\d+\.(key|crt|csr|pem)$/i, level: 'critical' },
  { id: 'env_file', description: 'real .env file (only .env.example is allowed)', regex: /(^|\/)\.env(\.(local|development|production))?$/i, level: 'high' },
];

/** Markers that make a candidate value an obvious placeholder (not a secret). */
const PLACEHOLDER_REGEX = /FAKE|EXAMPLE|PLACEHOLDER|DUMMY|SAMPLE|REDACTED|CHANGE[_-]?ME|YOUR[_-]|XXX|<[^>]*>/i;

/**
 * True when a captured value is a CODE REFERENCE (an environment read such as
 * `process` dot `env` dot X, a `${...}` template expression, or an `import.meta`
 * read) rather than a literal secret. These read a secret from the environment
 * at runtime and are safe to commit.
 */
export function isCodeReference(value: string): boolean {
  return /\$\{|\bprocess\.env\b|\bimport\.meta\b/.test(value);
}

/** Paths whose secrets are EXPECTED fixtures (tests / examples) -> info only. */
export function isLowTrustPath(path: string): boolean {
  return /\.(test|spec)\.[tj]sx?$|\.example\.|(^|\/)(__)?fixtures?(__)?\//i.test(path) || /(^|\/)example-/i.test(path);
}

/** True when a candidate value is empty, very short, or an obvious placeholder. */
export function isPlaceholderValue(value: string): boolean {
  const t = value.trim();
  if (t.length <= 8) return true;
  return PLACEHOLDER_REGEX.test(t);
}

/** Downgrades a finding to `info` on low-trust paths; null = skip (placeholder). */
function effectiveLevel(base: RiskLevel, value: string | null, path: string): RiskLevel | null {
  if (value !== null && (isPlaceholderValue(value) || isCodeReference(value))) return null;
  if (isLowTrustPath(path)) return 'info';
  return base;
}

/** Classifies a path by its NAME alone (no content read). Pure. */
export function classifyRiskyFilename(path: string, status: FileStatus): SecretFinding | null {
  for (const rule of FILENAME_RULES) {
    if (!rule.regex.test(path)) continue;
    // A correctly-ignored key/cert/env file on disk is acceptable (local only).
    if (status === 'ignored') return null;
    return { path, rule: rule.id, description: rule.description, level: rule.level, status };
  }
  return null;
}

/**
 * Scans file CONTENT for secret material. Returns findings with rule + line only
 * (never the value). Placeholder/fixture matches are skipped or downgraded. Pure.
 */
export function scanContent(path: string, content: string, status: FileStatus): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of CONTENT_RULES) {
      const m = rule.regex.exec(line);
      if (!m) continue;
      const value = rule.valueGroup > 0 ? (m[rule.valueGroup] ?? null) : m[0];
      const level = effectiveLevel(rule.level, value, path);
      if (level === null) continue;
      findings.push({ path, rule: rule.id, description: rule.description, level, status, line: i + 1 });
    }
  }
  return findings;
}

/** Aggregate counts + an overall verdict (ok = no critical/high). */
export interface SecretScanSummary {
  critical: number;
  high: number;
  info: number;
  ok: boolean;
}

/** Summarises findings. `ok` is false when any critical/high finding exists. Pure. */
export function summarizeFindings(findings: readonly SecretFinding[]): SecretScanSummary {
  let critical = 0;
  let high = 0;
  let info = 0;
  for (const f of findings) {
    if (f.level === 'critical') critical++;
    else if (f.level === 'high') high++;
    else info++;
  }
  return { critical, high, info, ok: critical === 0 && high === 0 };
}

/** Recommended .gitignore patterns for secret/key/cert material. */
export const RECOMMENDED_GITIGNORE_PATTERNS: readonly string[] = [
  '.env',
  '.env*.local',
  '*.pem',
  '*.key',
  '*.crt',
  '*.cer',
  '*.csr',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  'betfair-*-env.txt',
  'client-*.key',
  'client-*.crt',
  'client-*.csr',
  'id_rsa',
  'id_rsa.pub',
  'id_ecdsa',
  'id_ed25519',
];

/** Returns the recommended patterns NOT already covered by the current ignore file. */
export function missingGitignorePatterns(currentGitignore: string): string[] {
  const present = new Set(
    currentGitignore
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#')),
  );
  return RECOMMENDED_GITIGNORE_PATTERNS.filter((p) => !present.has(p));
}

/** Renders a deterministic, VALUE-FREE report (path + level + rule only). Pure. */
export function renderSecretReport(
  findings: readonly SecretFinding[],
  summary: SecretScanSummary,
): string {
  const lines: string[] = [];
  lines.push('Security secrets / local-artifact check');
  lines.push('========================================');
  lines.push(`critical: ${summary.critical}   high: ${summary.high}   info: ${summary.info}`);
  lines.push('');
  if (findings.length === 0) {
    lines.push('No secret material or risky artifacts found in tracked/untracked files.');
  } else {
    // Deterministic order: level (critical>high>info), then path, then line.
    const order: Record<RiskLevel, number> = { critical: 0, high: 1, info: 2 };
    const sorted = [...findings].sort(
      (a, b) =>
        order[a.level] - order[b.level] ||
        a.path.localeCompare(b.path) ||
        (a.line ?? 0) - (b.line ?? 0),
    );
    for (const f of sorted) {
      const loc = f.line ? `:${f.line}` : '';
      lines.push(`  [${f.level.toUpperCase()}] ${f.path}${loc}  (${f.rule}, ${f.status})`);
    }
  }
  lines.push('');
  lines.push(summary.ok ? 'VERDICT: PASS — no committable secrets detected.' : 'VERDICT: FAIL — review the findings above.');
  return lines.join('\n');
}
