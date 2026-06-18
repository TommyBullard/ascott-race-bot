# Dynamic Tipster Weighting (Phase 4D)

**Status:** core implemented (formula, calibration, snapshots, audit, read-only API).
**Mandate:** decision-support only. It produces an *explainable* per-tipster
weight from seven factors and **does not modify betting logic**. The live model
path (`modelProbabilities.ts` → `bettingEngine.ts` → `recommendBet.ts`) is
untouched; influence is gated by a ramp that defaults to **off**.

---

## 0. Why this exists

Approved tipsters currently contribute little because the model's tipster weight
is a cohort **min‑max** of `0.5·ROI + 0.3·A/E + 0.2·strike`
([modelProbabilities.ts](../src/lib/modelProbabilities.ts)) — fragile with few
tipsters, blind to sample size, Ascot/festival context, recency, and
calibration. This phase adds a **richer, shrinkage-based, explainable** weight as
decision-support, plus a safe, gradual path to (optionally, later) integrate it.

---

## 1. Weighting formula

Each factor maps to a **skill** `sᵢ ∈ [0,1]` (0.5 = neutral) via an **absolute**
anchor (not cohort min‑max), so scores are comparable across runs and
self-explanatory.

$$\text{logistic}(x)=\frac{1}{1+e^{-x}}, \quad
s_{\text{ROI}}=\text{logistic}\!\left(\tfrac{\text{ROI}}{0.10}\right), \quad
s_{\text{strike}}=\text{logistic}\!\left(\tfrac{\text{strike}-0.15}{0.12}\right)$$

**Per-factor sample shrinkage** pulls thin segments toward neutral
($r=\frac{n}{n+K}$, segment $K=50$):

$$s_i \leftarrow 0.5 + r_i\,(s_i - 0.5)$$

Ascot and festival use $s_{\text{ROI}}$ on their **segment** ROI with their own
$n$. Recent form uses $s_{\text{ROI}}$ on recent ROI, shrunk by a **recency**
reliability (1 ≤7 days, decaying to 0 by 90). Calibration skill is the ECE score
(below), shrunk by its pick count.

**Composite over present factors** (weights sum to 1; coverage-aware):

| factor | weight |
| --- | ---: |
| ROI | 0.30 |
| recent form | 0.22 |
| confidence calibration | 0.18 |
| strike rate | 0.12 |
| Ascot performance | 0.10 |
| festival performance | 0.08 |

$$\text{raw\_skill}=0.5+\frac{\sum_{i\in present} w_i\,(s_i-0.5)}{\sum_{i\in present} w_i},\qquad
\text{coverage}=\frac{\sum_{present} w_i}{\sum_{all} w_i}$$

**Global shrinkage** by sample size **and** coverage ($K=200$):

$$\text{reliability}=\frac{N}{N+200},\qquad
\boxed{\;\text{dynamic\_weight}=0.5+\text{reliability}\cdot\text{coverage}\cdot(\text{raw\_skill}-0.5)\;}$$

**Gradual ramp** (the only integration knob; $\alpha$ **defaults to 0**):

$$\text{effective\_weight}=0.5+\alpha\,(\text{dynamic\_weight}-0.5)$$

This satisfies the requirements directly: **small samples** → low `reliability` →
shrink to 0.5; **unreliable / thin coverage** → shrink to 0.5; **gradual
influence** → raise `α` slowly; **explainable** → every `sᵢ`, `wᵢ`, `rᵢ`, and
contribution is reported.

**Confidence calibration (ECE).** Bin a tipster's settled picks by implied prob
$p=1/\text{odds}$; compare each bin's mean $p$ to its hit-rate:

$$\text{ECE}=\sum_b \tfrac{n_b}{N}\,\bigl|\overline{p}_b-\text{hit}_b\bigr|,\qquad
s_{\text{calib}}=\operatorname{clamp}_{[0,1]}\!\left(1-\tfrac{\text{ECE}}{0.20}\right)$$

All constants live (and are unit-tested) in
[tipsterDynamicWeight.ts](../src/lib/tipsterDynamicWeight.ts).

---

## 2. Pseudocode

```text
function dynamicWeight(t, alpha = 0, now):
    N = usable(t.betsCount)                       # null if <= 0
    factors = []

    # whole-record factors (no segment shrink)
    add(factors,'roi',         skillFromRoi(t.roi),                 rel=1)
    add(factors,'recent_form', skillFromRoi(t.recentRoi),
                               rel=recencyReliability(daysSince(t.lastSeen, now)))
    add(factors,'strike_rate', skillFromStrike(t.strikeRate),       rel=1)

    # segment factors (shrink by their own small-N reliability, K=50)
    add(factors,'calibration', t.calibrationScore,  rel = nf/(nf+50))   # nf = calib picks
    add(factors,'ascot',       skillFromRoi(t.ascotRoi),    rel = na/(na+50))
    add(factors,'festival',    skillFromRoi(t.festivalRoi), rel = nh/(nh+50))

    present       = [f in factors if f.metric is not null]
    presentWeight = sum(f.weight for f in present)
    coverage      = presentWeight / sum(all factor weights)
    rawSkill      = 0.5 + sum(f.weight*(shrink(f.skill,f.rel)-0.5) for f in present)
                          / max(presentWeight, eps)

    reliability   = N>0 ? N/(N+200) : 0
    dynamicWeight = 0.5 + reliability*coverage*(rawSkill - 0.5)
    effective     = 0.5 + clamp(alpha,0,1)*(dynamicWeight - 0.5)
    return { dynamicWeight, rawSkill, reliability, coverage, effective,
             factors, reasons: explain(...) }

# add(): records skill, weight, per-factor reliability, contribution = weight*(shrunkSkill-0.5)
# shrink(s, r) = 0.5 + r*(s - 0.5)
```

Per-pick aggregation that feeds the segments (computed by the audit/pipeline from
`tipster_selections ⋈ races ⋈ runners`):

```text
for each settled pick p of tipster t:
    won   = (p.finish_pos == 1)
    ret   = won ? (bsp_or_sp(p) - 1) : -1            # level-stakes unit return
    bucket p into: all, recent(≤30d), ascot(course=Ascot), festival(meeting∈FESTIVALS)
segmentROI(bucket) = mean(ret over bucket);  n(bucket) = |bucket|
calibrationSamples = [{ impliedProb: 1/odds, won } ...]   # → computeCalibrationScore
```

---

## 3. Database changes (additive, decision-support only)

Migration
[20260618010000_tipster_dynamic_weights.sql](../supabase/migrations/20260618010000_tipster_dynamic_weights.sql):
new table **`tipster_dynamic_weights`** — one as-of snapshot per tipster
(`unique(tipster_id, as_of_date)`), storing `dynamic_weight`, `raw_skill`,
`reliability`, `coverage`, `ramp_alpha`, `effective_weight`, each factor input,
and `factors`/`reasons` JSON for the explanation. **No existing table is
altered.** `tipster_priors` (the betting read-path) is untouched. `check:db` was
extended to verify the new table/indexes.

> The weight is **not** stored on `tipster_priors` precisely so it can never leak
> into the model read-path by accident.

---

## 4. Model integration approach (safe, gradual, reversible)

**Default = no change.** Nothing reads `effective_weight` in the betting path
today. The integration, when validated, is a **one-line, ramped swap** behind a
flag — never a rewrite:

```text
# FUTURE, behind a config flag, in ONE place (computeTipsterWeights):
#   weight(tipster) = applyRamp(dynamicWeight(tipster), alpha_global * tipster.reliability)
# alpha_global starts at 0 (identical to today) and is raised only after:
```

1. **Shadow** (now): snapshot dynamic weights daily (`--commit`); compare to
   outcomes offline. Zero betting impact.
2. **Backtest gate**: extend [backtest.ts](../scripts/backtest.ts) with a
   `dynamic` mode; promote only if it beats the control on **calibration + ROI**
   without added drawdown (the repo's existing promotion rule —
   [MODEL_CHANGE_CHECKLIST.md](./MODEL_CHANGE_CHECKLIST.md)).
3. **Gradual ramp**: raise `alpha_global` in small steps (e.g. 0 → 0.25 → 0.5),
   each step re-validated; per-tipster influence also scales with that tipster's
   own `reliability`, so new tipsters earn influence slowly.
4. **Kill switch**: `alpha_global = 0` instantly restores today's behaviour.

Because `applyRamp(w, 0) = 0.5` (neutral) for everyone, **α = 0 is provably a
no-op**, which is what keeps this "decision-support only" until a deliberate,
validated decision says otherwise.

---

## 5. Dashboard visualisation

Read-only API: **`GET /api/tipsters/dynamic-weights`**
([route](../src/app/api/tipsters/dynamic-weights/route.ts)) → `{ alpha, tipsters:
DynamicWeightEntry[] }`. `?alpha=0.5` previews a ramp (changes nothing live).

Suggested panel (natural home: the existing
[/leaderboard](../src/app/leaderboard/page.tsx)) — a **factor-contribution bar**
per tipster plus a shrinkage indicator:

```tsx
// Each tipster row: dynamic_weight as a 0–1 bar (neutral mark at 0.5), then a
// stacked mini-bar of signed factor contributions (green right / red left),
// with reliability + coverage as small dots. Demoted tipsters greyed.
function WeightBar({ a }: { a: DynamicWeightResult }) {
  return (
    <div>
      <Meter value={a.dynamic_weight} neutral={0.5} />        {/* headline weight */}
      <FactorStrip factors={a.factors} />                      {/* per-factor +/- */}
      <small>N={a.bets_count ?? 0} · reliability {a.reliability}
             · coverage {a.coverage} · α {a.ramp_alpha}</small>
      <ReasonList reasons={a.reasons} />                       {/* explainability */}
    </div>
  );
}
```

The CLI audit (`npm run tipsters:weights`) renders the same data as a console
table + per-tipster "why", so the intelligence is visible without the UI.

---

## 6. Explanation generation

Every assessment carries `factors[]` (each with `skill`, `weight`,
`sampleSize`, `reliability`, signed `contribution`) and a `reasons[]` list that
leads with the shrinkage headline, e.g.:

```
N=1200 → reliability 0.857, coverage 0.64 → weight 0.69 (raw 0.79)
ROI +18.0%
recent ROI +14.0% (2d old, recency×1)
strike 30.0%
small sample (N=18) → heavily shrunk toward neutral        # for thin tipsters
ramp α=0 → effective weight neutral (no betting influence)
```

Generation is pure and deterministic
([scoreDynamicTipsterWeight](../src/lib/tipsterDynamicWeight.ts)); the dashboard
and audit both render the same `reasons[]`, so the displayed justification can
never drift from the number.

---

## 7. Files

| File | Role |
| --- | --- |
| [src/lib/tipsterDynamicWeight.ts](../src/lib/tipsterDynamicWeight.ts) | Pure formula, shrinkage, ECE calibration, ramp, explanation |
| [scripts/tipsterDynamicWeight.test.ts](../scripts/tipsterDynamicWeight.test.ts) | 15 unit tests |
| [src/lib/tipsterDynamicWeightApi.ts](../src/lib/tipsterDynamicWeightApi.ts) | Assembly from leaderboard + read API + snapshot persistence |
| [src/app/api/tipsters/dynamic-weights/route.ts](../src/app/api/tipsters/dynamic-weights/route.ts) | Read-only API (`?alpha=` preview) |
| [scripts/tipsterWeightAudit.ts](../scripts/tipsterWeightAudit.ts) | `npm run tipsters:weights` decision-support report (`--commit` snapshots) |
| [supabase/migrations/20260618010000_tipster_dynamic_weights.sql](../supabase/migrations/20260618010000_tipster_dynamic_weights.sql) | Additive snapshot table |

**Out of scope (by mandate):** any change to model probability, EV, staking,
ranking, recommendations, or auto-activation. Ascot/festival/calibration segments
are `null` until the pick-level aggregation pipeline (§2) is wired — never
fabricated.
