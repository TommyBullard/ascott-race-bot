# Neural Network Extension — Design & Evaluation Plan

> **Status: PLANNING ONLY. Not approved for production.**
>
> This document designs a possible machine-learning (ML) / neural-network (NN)
> extension to the racing value model. It deliberately contains **no production
> inference, no model weights, no ML dependencies, and no runtime prediction
> code**. The production model remains the existing **rules / market-based**
> system until the go/no-go criteria in this document are met on out-of-sample
> data, audited for leakage.
>
> This is a **financial-risk decision-support system**. The default answer to
> "should we ship the neural network?" is **no**, and the burden of proof is on
> the model to clear an explicit, pre-registered bar — not on the baseline to
> defend itself.

---

## 0. Scope and non-goals

**In scope (this document):**

- The case for keeping the market as the baseline.
- A concrete, leakage-aware feature/label specification.
- A date-based evaluation protocol and calibration requirements.
- A conservative blend-and-cap inference strategy (design only).
- Pre-registered go/no-go criteria for any future production use.

**Explicitly out of scope (and forbidden until go/no-go passes):**

- Production NN inference, runtime prediction logic, or model files/weights.
- Adding ML dependencies (training frameworks, ONNX runtimes, etc.) to the
  production app.
- External prediction API calls.
- Using generative AI to produce probabilities or selections.
- Changing the production probability math in
  [`src/lib/modelProbabilities.ts`](../src/lib/modelProbabilities.ts) or the
  staking math in [`src/lib/bettingEngine.ts`](../src/lib/bettingEngine.ts).

Any future implementation must be staged behind the offline evaluation pipeline
(`scripts/evaluatePredictions.ts`, planned) and must not write to
`model_runner_scores` / `recommendations` until approved.

---

## 1. Why the neural network must NOT replace the market baseline

The de-overrounded market probability (`market_prob`, computed as normalised
`1/odds` across the priced field) is an extremely strong, hard-to-beat baseline.
Treat it as the incumbent that any model must **beat after costs**, not merely
correlate with.

1. **The market is already a calibrated ensemble.** Closing odds aggregate the
   capital-weighted opinions of many sharp participants. Beating the *pre-race*
   line consistently — net of commission and slippage — is the entire game and
   is rare.
2. **Small data, high noise.** A single race yields one outcome from a field of
   many. Win/lose labels are extremely noisy; an over-parameterised NN will
   memorise noise and *look* brilliant in-sample while losing money live.
3. **Non-stationarity.** Going, draw bias, class, trainers/jockeys in form, and
   market microstructure drift over time. A model tuned to last season can be
   anti-predictive this season.
4. **Asymmetric, real financial downside.** Errors are not symmetric academic
   loss — they are staked money. Overconfidence in the tails (long shots) is
   ruinous under Kelly-style staking.
5. **Leakage is easy and deadly.** Many attractive "features" (model outputs,
   closing prices, results) encode the answer. A leak inflates offline metrics
   and silently transfers money to the market in production (see §5).
6. **Interpretability and auditability.** The rules/market system is fully
   inspectable (`rationale_json`, `model_runner_scores`). A black-box probability
   that we cannot explain is a liability in a money-at-risk system.

**Conclusion.** The NN is a candidate **augmentation** (a bounded adjustment to
the market prior), evaluated as a challenger, never an unbounded replacement.
The market prior is the safe default the system falls back to whenever the model
is uncertain, untested on a regime, or missing inputs.

---

## 2. Proposed input features

Features must be **strictly pre-race** and reuse the planned pure extractor
[`src/lib/runnerFeatures.ts`](../src/lib/runnerFeatures.ts) (Batch 8) so the
exact same code path produces training rows and (eventual) inference rows. This
"single feature source" rule is the primary defence against train/serve skew.

**Hard rules for every feature:**

- **Never fabricate.** A missing value is `null` — never imputed with a guess,
  a zero, or a mean baked from the future. Imputation, if any, is a documented,
  versioned transform fit **only on the training split**.
- **No post-off information.** Anything known only at or after the off time is a
  label or metadata, never a feature (see §5).
- **Provenance-tagged.** Each feature carries which source/window produced it so
  leakage audits are mechanical.

### 2.1 Market features (primary signal)

| Feature | Notes |
| --- | --- |
| `implied_probability` | `1/odds` for the runner. |
| `normalized_market_probability` | De-overrounded across the priced field (the baseline itself). |
| `odds` | Latest **pre-race** decimal price. |
| `odds_rank` | Rank within the field by price. |
| `odds_movement_5m` / `odds_movement_15m` | Drift vs. snapshot at/ before the window; `null` if no qualifying earlier snapshot. |
| `odds_volatility` | Dispersion of the runner's snapshot series; `null` with < 2 points. |

> Market features will dominate. That is expected and acceptable: the NN's job
> is to find **small, robust residual** structure the market underweights, not
> to reinvent the price.

### 2.2 Race context features (where available)

| Feature | Availability caveat |
| --- | --- |
| `runner_count` | Derivable from the field. |
| `course` | Persisted on `races`. |
| `off_time` | Persisted on `races`. |
| `distance` | **Not currently persisted** — The Racing API exposes `distance_f`, but ingestion does not store it yet. `null` until a future ingestion change. |
| `going` | **Not currently persisted** (same as above). `null` until ingested. |
| `race_class` | **Not currently persisted** (same as above). `null` until ingested. |

> Distance / going / race_class require an ingestion batch to add columns to
> `races` and persist the API fields. Until then they are honestly `null` and
> must not be invented. Categorical fields (course, going, class) require a
> frozen encoding fit on the training split only.

### 2.3 Human / signal features (where available)

| Feature | Availability caveat |
| --- | --- |
| `trainer_recent_roi` | Requires a real, windowed trainer prior keyed to the runner. `runners` stores trainer as **text only** today → `null` unless supplied. Must use a strictly *pre-race* window. |
| `jockey_recent_roi` | As above for jockey. |
| `trainer_jockey_combo_score` | Caller-supplied; no formula invented here. |
| `tipster_support_count` | Count of distinct tipsters backing the runner (`tipster_selections`). Live pipeline does not populate selections yet → typically `0`. |
| `weighted_tipster_support` | Quality-weighted support (needle weights). `null` when no selections. |

### 2.4 Explicitly excluded from features (leakage — see §5)

`model_prob`, `ev`, `confidence`, `recommendation_rank`, `stake` (model
**outputs**); `finish_pos`, `won`, `bsp_decimal`, `sp_decimal`, any closing /
in-play price (**post-off outcomes**).

---

## 3. Target label

- **Primary label:** `won ∈ {0, 1}` — did this runner win? One row per runner;
  exactly one positive per completed race (dead heats handled explicitly, not
  silently — exclude or split per a documented rule).
- **Task framing:** per-runner win probability, **renormalised within a race**
  so the field sums to 1 before any betting metric is computed. A raw
  independent sigmoid per runner is not a valid race distribution.
- **Settlement-only labels** (carried as `label_*`, never features):
  `finishing_position`, `betfair_sp`.
- **No fabrication:** rows from void / abandoned / non-settled races are
  **skipped**, not assigned a synthetic outcome.

> Optional future target: a place/each-way head. Out of scope for v1 — win-only
> keeps the label clean and the evaluation honest.

---

## 4. Train / validation / test split — by DATE, never random

A random split leaks the future into the past (same race split across folds;
season-level regime bleed). **All splits are strictly chronological by
`meeting_date`**, with a gap.

```
|<---- TRAIN ---->|gap|<-- VALIDATION -->|gap|<---- TEST (locked) ---->|
   oldest races          model selection         most recent races
                          + calibration fit       touched ONCE, at the end
```

- **Train:** oldest contiguous date range — fit parameters only.
- **Validation:** next contiguous range — architecture/hyperparameter selection,
  early stopping, **and** calibration fitting (§6).
- **Test:** most recent contiguous range — **locked**. Used **once**, for the
  final go/no-go (§12). No peeking, no tuning against it.
- **Embargo gap** between folds (e.g. several days) so multi-day market moves,
  late results, or overlapping meetings cannot bridge folds.
- **Walk-forward / rolling-origin** evaluation is the preferred final protocol:
  repeatedly train on `[..t]`, test on `[t+gap .. t+gap+w]`, advance. This
  mirrors live deployment, where you only ever know the past.
- **Time-series cross-validation only** (expanding or sliding window). **No
  k-fold shuffling. Ever.**

---

## 5. Leakage risks (treat as the primary threat)

Leakage is the single most likely way this project loses money. Enumerate,
test, and gate on it.

| # | Risk | Control |
| --- | --- | --- |
| L1 | **Target leakage** — using model outputs (`model_prob`, `ev`, `rank`) or outcomes (`finish_pos`, `bsp`) as features. | Hard column segregation: `feat_*` vs `label_*` vs `meta_*` in the training export (Batch 9). Features come only from `runnerFeatures.ts`. Automated check fails the build if a `label_*`/`meta_*` column enters the feature matrix. |
| L2 | **Lookahead / post-off prices** — using closing or in-play odds. | Features use only snapshots strictly before `off_time`. Closing price (BSP) is used **only** for settlement and CLV, tagged `label_/meta_`. |
| L3 | **Temporal leakage** — random split, or fitting encoders/scalers/imputers on the full dataset. | Date split + embargo (§4). All transforms `fit()` on train only, then `transform()` elsewhere. |
| L4 | **Normalisation leakage** — using future field/population stats. | Within-race renormalisation uses only same-race runners; cohort stats (e.g. tipster z-scores) computed within the run, never across the test horizon. |
| L5 | **Survivorship / matching leakage** — dropping unmatched or abandoned races in a way correlated with outcome. | Skip reasons are logged and counted; skip rates audited for outcome correlation. Never silently drop. |
| L6 | **Label leakage via priors** — trainer/jockey ROI windows that include the race being predicted or later races. | Priors must be as-of strictly `< off_time`; verify the prior's `as_of_date` precedes the race. |
| L7 | **Duplicate / overlapping rows** — same race ingested twice; re-runs. | Deduplicate by `(race_id, runner_id)`; use append-only model history honestly. |
| L8 | **Multiple-comparisons / test reuse** — tuning until the test set passes. | Test set locked; one evaluation; pre-registered metrics and thresholds (§12). |

**Leakage acceptance test:** a deliberately shuffled-label run must collapse to
baseline (Brier ≈ market, ROI ≈ negative the commission). If a model still
"works" on shuffled labels, there is a leak — stop.

---

## 6. Calibration requirements

For staking, **calibration matters more than discrimination**. A model that
ranks well but is overconfident will bankrupt a Kelly staker.

- **Mandatory post-hoc calibration**, fit on the **validation** split only
  (isotonic regression or Platt/temperature scaling). Never fit on test.
- **Reliability diagrams** + **Expected Calibration Error (ECE)** reported per
  probability bucket (reuse the planned calibration buckets in
  `performanceMetrics.ts`).
- **Per-odds-band calibration** (favourites vs. mid vs. long shots): the model
  must be calibrated **in each band**, especially long shots (≥ ~8.0), where
  overconfidence is most expensive. A model may be globally calibrated yet
  dangerously miscalibrated in the tail.
- **Within-race coherence:** calibrated probabilities renormalise to ~1.0 per
  race without large rescaling (large rescale ⇒ miscalibration).
- **Calibration gate:** post-calibration **ECE must not exceed the market's
  ECE** on validation. If the market is better calibrated, the model does not
  ship as a probability source.

---

## 7. Minimum data requirements

Do not train a serious model below these floors — under them, prefer the market
baseline outright. These are **pre-conditions**, not sufficiency conditions.

| Requirement | Rationale |
| --- | --- |
| **Thousands of settled races** (target ≳ 5,000; hard floor ~2,000) across the test horizon | Win labels are 1-per-race and noisy; small N ⇒ unstable, over-fit models. |
| **Multiple seasons / regimes** spanning going, class, course types | Guards against fitting one transient regime. |
| **Complete pre-race odds time-series** per race | Movement/volatility features and honest CLV require real snapshots, not a single price. |
| **Settlement coverage** (BSP/SP + finishing positions) on the vast majority of races | Needed for trustworthy labels, ROI, and CLV. |
| **Stable feature availability** | If a feature is `null` for most rows (e.g. distance/going until ingested, trainer/jockey ROI until sourced), it is not yet usable — do not impute it into existence. |
| **Documented, versioned dataset** | Export is reproducible (date range, code version, row/skip counts) so a result can be re-derived. |

Keep a **model capacity ↔ data** discipline: start with **regularised linear /
logistic or gradient-boosted trees** as the ML reference before any neural net.
A NN is only justified if it beats that simpler ML reference *and* the market on
locked test data. Most likely a small, heavily-regularised model wins.

---

## 8. Inference strategy (DESIGN ONLY — not for production yet)

When (and only when) §12 passes, inference would be **offline-trained,
artifact-loaded, and bounded** — never live training, never an external call.

- **Offline training** produces a versioned, immutable artifact + a frozen
  preprocessing spec + the fitted calibrator. Versioned alongside
  `probability_engine_version` semantics.
- **Same feature code** (`runnerFeatures.ts`) at train and serve — no bespoke
  serving transforms.
- **Shadow mode first:** compute `p_model` and persist it to a **separate,
  clearly-labelled** field for comparison **without affecting any
  recommendation**. Run shadow for a meaningful live period and re-confirm §12
  on truly unseen live races.
- **Graceful degradation:** if any required feature is missing, the model
  abstains for that runner and the system uses the market prior. Missing inputs
  never produce a guessed probability.
- **No generative AI** anywhere in the path. No network calls at inference.
- **Kill switch:** a single config flag instantly reverts to market/rules-only.
  Reverting must require no redeploy.

---

## 9. Blending neural probability with market probability

Even after passing, the model is a **bounded adjustment to the market prior**,
never a free-standing probability. Blend in **log-odds (logit) space** so the
market remains the anchor.

```
logit(p_blend) = logit(p_market) + w * clamp( logit(p_model) - logit(p_market), -Δ, +Δ )
p_blend(raw)   = sigmoid( logit(p_blend) )
p_blend        = renormalise p_blend(raw) across the race so the field sums to 1
```

- `p_market` = de-overrounded market probability (the anchor).
- `w ∈ [0, 1]` = trust weight, **small by default** (e.g. start ≤ 0.3), chosen
  on validation, **not** test.
- `Δ` = per-runner cap on how far the model may move the market in log-odds
  (§10).
- **Renormalise within the race** after blending.
- `w` may be **shrunk by confidence/coverage**: lower `w` (toward 0, i.e. pure
  market) when inputs are sparse, the race type is under-represented in
  training, or the calibrator is extrapolating.

**Default posture:** `w = 0` (pure market) is the safe state. The model earns
weight only by evidence.

---

## 10. Capping probability adjustments

Caps exist so a model error cannot create a catastrophic bet. Apply **before**
EV/stake.

- **Log-odds cap `Δ`:** bound `|logit(p_model) − logit(p_market)|` per runner
  (e.g. start ~0.5–1.0 logits). The model nudges; it cannot overrule the market.
- **Absolute probability cap:** also clamp `|p_blend − p_market|` to a ceiling
  (e.g. ≤ a few percentage points) as a second guardrail.
- **Tail clamps:** floor/ceiling final probabilities away from 0 and 1 to bound
  log loss and prevent Kelly blow-ups on long shots; tighten caps further in the
  long-shot band.
- **Stake interaction:** caps compose with the **existing** fractional-Kelly
  (0.2) and the 0.1%–2% bankroll clamp in
  [`src/lib/bettingEngine.ts`](../src/lib/bettingEngine.ts) — the ML path does
  **not** relax those guardrails. Net staking risk must be ≤ the current system.
- **No-bet on disagreement:** if model and market disagree beyond `Δ`, prefer
  **no bet** over a large bet (defer to Batch 5 risk-control / no-bet logic).

---

## 11. Comparing against the market-only baseline

The market-only model is the **control arm** and is always evaluated alongside
any challenger via `scripts/evaluatePredictions.ts` (planned), on **settled
races only**, skipping incomplete rows, never fabricating.

**Sources compared head-to-head:**

1. **Market-only** (`market_prob`) — the baseline to beat.
2. **Current rules model** (`model_prob`, persisted in `model_runner_scores`).
3. **ML model** — only if a probability file is supplied offline; absent ⇒
   skipped, never invented.

**Metrics (identical for every source):** Brier score, log loss, calibration
buckets / ECE, flat-stake ROI, model-stake ROI, strike rate, average odds, ROI
by odds band, max drawdown, and **closing line value (CLV)** vs. BSP where data
exists.

- **CLV is the leading indicator.** Beating the closing line (positive CLV, net
  of commission) is more trustworthy than raw ROI, which is high-variance over
  small samples. A strategy with negative CLV but positive ROI is presumed lucky.
- **Significance, not point estimates:** report bootstrapped confidence
  intervals on ROI/CLV differences and paired comparisons across the
  walk-forward folds. One good month is noise.
- **Cost realism:** apply Betfair commission and realistic slippage; evaluate at
  obtainable pre-race prices, not optimistic post-hoc BSP.

---

## 12. Go / No-Go criteria for production use

**Pre-registered. All criteria measured on the LOCKED test horizon (and then a
live shadow period) — defined before final evaluation, not adjusted to fit.**

**GO requires ALL of the following:**

1. **Calibration:** post-calibration ECE ≤ market ECE overall **and** within
   every odds band (no dangerous tail miscalibration).
2. **Probabilistic skill:** Brier **and** log loss strictly better than
   market-only by a margin with a 95% bootstrap CI that **excludes zero**.
3. **Beats a simple ML reference:** also outperforms a regularised
   logistic/GBT model — i.e. the *neural* complexity is justified, not just "ML".
4. **CLV:** blended strategy shows **positive mean CLV net of commission**, CI
   excluding zero, across walk-forward folds.
5. **Economic edge after costs:** model-stake ROI > market-only ROI net of
   commission/slippage, robust across folds and **positive in the most recent
   fold** (no decay).
6. **Risk not worse:** max drawdown and stake distribution **no worse** than the
   current system under identical staking caps.
7. **Leakage audit passed:** L1–L8 controls green; shuffled-label test collapses
   to baseline; feature-provenance audit clean.
8. **Robustness:** no single course/class/season drives the edge; performance
   stable across regimes; sensitivity to `w`/`Δ` is gentle (no knife-edge).
9. **Operational safety:** shadow-mode parity confirmed live; kill switch and
   graceful degradation verified; artifact/version/repro documented.

**NO-GO (ship nothing; stay market/rules-only) if ANY hold:**

- Any GO criterion unmet, marginal, or CI-overlapping zero.
- Edge exists only in-sample, only in older folds, or only at optimistic prices.
- Any unresolved leakage signal.
- Calibration worse than market in any band.
- Required features predominantly `null` (insufficient real data).
- Result cannot be reproduced from the versioned dataset + artifact.

**Default outcome is NO-GO.** Borderline ⇒ NO-GO. The market baseline is retained
whenever the challenger has not *decisively* and *reproducibly* won out of
sample, after costs, without leakage. Even on GO, deploy **bounded and in shadow
first**, re-confirm live, and keep the kill switch one flag away.

---

## 13. Suggested staging (each a separate, approval-gated batch — design only)

These are **not** authorised by this document; they are the order in which the
work *would* proceed if pursued. No production ML ships before §12 passes.

1. Data foundation: confirm `runnerFeatures.ts` (Batch 8) + training export
   (Batch 9) with the `feat_/label_/meta_` leakage split.
2. Evaluation harness: `performanceMetrics.ts` + `scripts/evaluatePredictions.ts`
   with market & rules sources and the optional offline ML source.
3. Offline research (outside production): simple ML reference, then NN; date
   splits, calibration, leakage audits — all offline.
4. Shadow integration: persist `p_model` to a labelled field, no betting impact.
5. Go/No-Go review against §12 on locked test + shadow period.
6. Only on GO: bounded blended inference behind a kill switch, low `w`, tight
   caps, continuous monitoring.

---

## 14. Optional TODO interfaces (types only — NOT an implementation)

If useful, these **type stubs** can live beside the planned modules to document
the eventual contract. They must remain **types only** — no functions, no
weights, no runtime — until §12 passes.

```ts
// DESIGN STUB ONLY — do not implement production inference until go/no-go passes.

/** A model's per-runner win probability for one race (renormalised to sum ~1). */
export interface RunnerProbabilityPrediction {
  runner_id: string;
  /** Win probability in [0, 1]; null when the model abstains (missing inputs). */
  probability: number | null;
  /** Identifies the source/version, e.g. 'market_v1' | 'rules_v1' | 'nn_vX'. */
  source: string;
}

/** Offline-supplied ML probabilities consumed ONLY by the evaluation script. */
export interface ImportedMlProbabilities {
  model_version: string;
  trained_through: string; // ISO date; must precede every evaluated race
  predictions: RunnerProbabilityPrediction[];
}

/** Bounded blend config (see §9–§10). Defaults to pure market (w = 0). */
export interface BlendConfig {
  trustWeight: number;      // w in [0, 1]
  maxLogOddsShift: number;  // Δ cap, per runner
  maxAbsProbShift: number;  // absolute probability cap, per runner
}
```

---

### Document control

- **Owner:** model maintainer.
- **Review cadence:** revisit only when data-volume or feature-availability
  preconditions (§7) materially change.
- **Authority:** this document authorises **no** production ML. Production
  remains the rules/market system until the §12 bar is cleared, audited for
  leakage, on out-of-sample data.
