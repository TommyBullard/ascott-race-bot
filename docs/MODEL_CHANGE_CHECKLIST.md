# Model-change checklist

A required checklist for **any change that can affect the model** — its
probabilities, staking, ranking/selection, confidence, tipster handling, or how
performance is evaluated. **Documentation only**: this file defines the process;
it does not change any code.

> **Responsible use.** Ascott Race Bot is a personal **research / decision-support**
> tool. It does **not** predict winners and offers **no guaranteed profit, no
> "sure things", and no risk-free bets**. This checklist exists to keep changes
> honest, testable, and reversible — not to chase results. All betting involves
> risk.

Use this alongside [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) (§11 Hard safety
rules), [MODEL_IMPROVEMENT_BUILD_PLAN.md](MODEL_IMPROVEMENT_BUILD_PLAN.md) (the
research backlog and evaluation discipline), and
[ML_NEURAL_NETWORK_PLAN.md](ML_NEURAL_NETWORK_PLAN.md) (leakage/GO-NO-GO rules).

---

## 1. Purpose

Any model-affecting change **must be reviewed, tested, and evaluated against the
market-only baseline** before it is allowed to influence what the dashboard
shows or recommends. The default posture is scepticism: a change is assumed not
to help until evidence on out-of-sample, pre-off data shows otherwise.

A change is "model-affecting" if it touches any of:

- probability estimation (`modelProbabilities`),
- staking / EV / Kelly (`bettingEngine`),
- ranking or selection of the recommended runner,
- confidence scoring or its scaling,
- tipster weighting, consensus, or de-correlation,
- which model run is treated as a race's decision record (evaluation/selection),
- data-quality gating, stake suppression, or no-bet/skip logic.

Pure documentation, copy, or non-model UI changes are out of scope for this
checklist (but still need green gates).

---

## 2. Required before implementation

Write these down in the change's issue/PR description **before** coding:

- [ ] **Explicit scope** — exactly what is and is not being changed (one or two
      sentences), and the smallest change that achieves it.
- [ ] **Expected behaviour** — what observably changes (a pick, a number, a
      label) and what must stay identical.
- [ ] **Affected files** — the concrete list, separating *model logic* from
      *evaluation/plumbing/UI/docs*.
- [ ] **Change classification** — state plainly whether this changes
      **probability**, **staking**, **confidence**, and/or **evaluation** (any
      "yes" raises the evaluation bar in §4).
- [ ] **Leakage-risk review** — confirm no post-race or post-off information
      (finishing position, BSP, in-running, settled status, or a post-off run)
      can enter a pre-off feature, a probability, or the decision record.
- [ ] **Source / legal review** — any new data is **manual, public, or properly
      licensed**; never scraped from private, paywalled, logged-in, or
      ToS-restricted places. No secrets added to code or docs.
- [ ] **Rollback plan** — how to revert safely (feature flag off, default unchanged,
      or a clean `git revert`), written before merge.

---

## 3. Required tests

Add or update tests for the surface you touched. At minimum:

- [ ] **Unit tests** for the new/changed pure logic (deterministic; no DB, no
      network, no secrets).
- [ ] **Regression tests** that lock the behaviour a past bug produced — e.g. the
      [Royal Ascot Day 1 post-off scenario](../scripts/royalAscotDay1Regression.test.ts)
      (a pre-off recommendation must survive a later post-off no-bet run).
- [ ] **Stale / post-off behaviour tests** — post-off and `status = result` races
      are skipped or written non-current and never supersede the pre-off run;
      evaluation selects `run_time <= off_time`.
- [ ] **No-fabrication tests** — missing/ambiguous inputs map to null / `unknown`
      / skipped, never an invented value, price, or position.
- [ ] **Tipster de-correlation tests** *(if tipster handling changes)* — tipsters
      sharing a source are not double-counted as independent confirmation.
- [ ] **Confidence-band tests** *(if confidence changes)* — band assignment is
      correct and a LOW signal is never silently promoted (see §5).

Run the full gate suite and keep it green:

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

---

## 4. Required evaluation

Evaluate on **historical races only**, using **only features known before the
off**. Always compare against the controls:

- [ ] **Market-only baseline** — the control the change must beat (or at least not
      harm).
- [ ] **Current model baseline** — the live behaviour before the change.
- [ ] **If probability changes:** Brier score, log loss, and **ECE / calibration
      error** by confidence band — calibration must not degrade.
- [ ] **If the recommendation changes:** ROI, strike rate, and **max drawdown** —
      no improvement is real if drawdown worsens unacceptably.
- [ ] **Confidence-band monotonicity** — higher confidence bands should not perform
      worse than lower ones; investigate if they do.
- [ ] **Odds-band performance** — check the change doesn't only "work" in one odds
      range (e.g. longshots) while harming others.
- [ ] **CLV / BSP realism** *(where available)* — value is measured against Betfair
      SP / the closing line, not nominal prices.

**Promotion rule:** promote only if the change improves calibration and/or ROI
**without** unacceptable drawdown, on out-of-sample data. "It looks better on one
card" is not evidence; only the metrics are.

---

## 5. Hard no-go rules

A change is rejected outright if it does any of these:

- [ ] **GenAI predicting winners.** GenAI is feature-extraction / reasoning-audit
      only; it never picks the winner and never invents facts.
- [ ] **Auto-betting.** No bet placement, no betting-API wiring, no staking
      automation. The tool stays read-only on the exchange.
- [ ] **Post-race leakage.** No post-race / post-off data in any pre-off feature,
      probability, or decision record.
- [ ] **Restricted-source scraping.** No private, paywalled, logged-in, or
      ToS-restricted sources.
- [ ] **Rescaling LOW confidence upward "to look better."** Confidence reflects the
      evidence; never inflate it for presentation. LOW that means "insufficient
      information" must stay LOW.
- [ ] **One-day / festival overfitting.** No hard-coding to a single good day or
      meeting. New signals are capped, decaying, and backtested — never certainties.
- [ ] **Deleting failed / loss-making history.** History is append-only; superseded
      and losing runs are preserved for audit. Never delete or rewrite them to
      improve the record.

---

## 6. Approval checklist

All boxes ticked before merge:

- [ ] **Reviewed by the user (operator).** Scope, classification, and risk review
      explicitly approved.
- [ ] **Gates green.** `lint`, `typecheck`, `test`, `build` all pass (record the
      counts).
- [ ] **Docs updated.** PROJECT_OVERVIEW / RACE_DAY_RUNBOOK / relevant plan docs
      reflect the new behaviour; this checklist followed.
- [ ] **Feature flag if behaviour changes.** A model-active behaviour change ships
      behind a flag, **off by default**, with the new path inert until enabled.
- [ ] **Rollback documented.** The exact revert/disable steps are written down and
      verified (kill switch for any model-active path).

---

> Reminder: this is **decision-support only, not betting advice**. The point of
> this checklist is explainability, testability, and reversibility — never a claim
> of accuracy or profit.
