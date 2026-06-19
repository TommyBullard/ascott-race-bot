/**
 * Pure, dependency-free ML-vs-model-vs-market agreement helper.
 *
 * Extracted so BOTH the server (CLIs, dashboard endpoint) and the client
 * (dashboard panel) can share one source of truth without the client pulling in
 * any server-only module. RESEARCH / DISPLAY ONLY — comparing three runner names
 * changes no probability, EV, staking, confidence, no-bet gate, or recommendation
 * and places/suggests no bet.
 */

/** Standard, unmissable shadow labels shown wherever ML output appears. */
export const ML_SHADOW_LABELS = {
  notModelActive: 'ML shadow pick — not model-active',
  researchOnly: 'Research only',
  noEffect: 'Does not affect staking or recommendations',
} as const;

/** Normalises a runner name for equality (trim + lowercase), or null. */
export function normRunnerName(name: string | null | undefined): string | null {
  if (name == null) return null;
  const t = name.trim().toLowerCase();
  return t === '' ? null : t;
}

/** Which of the three sources the ML pick lines up with. */
export type MlAgreementBadge =
  | 'all_agree'
  | 'ml_agrees_regular'
  | 'ml_agrees_market'
  | 'ml_differs_from_both'
  | 'unknown';

/** The full agreement breakdown for one race. */
export interface MlAgreement {
  ml_agrees_with_regular_pick: boolean;
  ml_agrees_with_market_favourite: boolean;
  regular_agrees_with_market_favourite: boolean;
  all_three_agree: boolean;
  all_three_disagree: boolean;
  badge: MlAgreementBadge;
  badge_label: string;
}

/**
 * Computes the agreement flags + display badge from the three picks' runner
 * names. Unknown (null) names never count as agreement. Pure.
 */
export function buildMlAgreement(
  regularPickName: string | null,
  marketFavouriteName: string | null,
  mlPickName: string | null,
): MlAgreement {
  const reg = normRunnerName(regularPickName);
  const mkt = normRunnerName(marketFavouriteName);
  const ml = normRunnerName(mlPickName);

  const mlReg = ml !== null && reg !== null && ml === reg;
  const mlMkt = ml !== null && mkt !== null && ml === mkt;
  const regMkt = reg !== null && mkt !== null && reg === mkt;
  const allThree = mlReg && mlMkt && regMkt;
  const allDisagree =
    ml !== null && reg !== null && mkt !== null && !mlReg && !mlMkt && !regMkt;

  let badge: MlAgreementBadge;
  let label: string;
  if (ml === null) {
    badge = 'unknown';
    label = 'ML shadow pick unavailable';
  } else if (allThree) {
    badge = 'all_agree';
    label = 'All three agree (ML, model, market)';
  } else if (mlReg) {
    badge = 'ml_agrees_regular';
    label = 'ML agrees with regular model';
  } else if (mlMkt) {
    badge = 'ml_agrees_market';
    label = 'ML agrees with market favourite';
  } else {
    badge = 'ml_differs_from_both';
    label = 'ML differs from both';
  }

  return {
    ml_agrees_with_regular_pick: mlReg,
    ml_agrees_with_market_favourite: mlMkt,
    regular_agrees_with_market_favourite: regMkt,
    all_three_agree: allThree,
    all_three_disagree: allDisagree,
    badge,
    badge_label: label,
  };
}
