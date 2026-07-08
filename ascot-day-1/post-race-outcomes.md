# Ascot Day 1 — Outcomes & Model Validation

> ARCHIVE NOTE: This document is historical and specific to Royal Ascot Day 1 (2026-06-16). Use `docs/RACE_DAY_RUNBOOK.md` for the current workflow and `CLAUDE.md` for authoritative AI assistant instructions.

Date: 2026-06-16  
Course: Ascot  

---

## 14:30 — Queen Anne Stakes

### Official Result
1. Ten Bob Tony — SP 50/1
2. More Thunder — SP 7/2 J2Fav
3. Opera Ballo — SP 7/2 J2Fav
4. Zeus Olympios — SP 11/1
5. Damysus — SP 14/1
6. Notable Speech — SP 9/4 Fav
7. Docklands — SP 6/1
8. Cicero's Gift — SP 50/1
9. First Conquest — SP 40/1

### Model Result
- Model pick: Docklands
- Finish position: 7th
- Outcome: Lost
- Stake: 1.00
- P/L: -1.00

### Validation Note
Manual result import worked. Model pick lost. Low-confidence/degraded pre-race warning was justified.

---

## 15:05 — Coventry Stakes

### Official Result
1. Great Barrier Reef — SP 6/1 2Fav
2. Adaay Of Scarlett — SP 40/1
3. Royal Heritage — SP 12/1
4. Cut A Dash — SP 12/1
5. Night In Vegas — SP 9/1
6. Confucius — SP 2/1 Fav
7. Final Objective — SP 125/1
8. Mrair — SP 18/1
9. Jaan Ki Tukri — SP 125/1
10. Kamaal — SP 200/1
11. Cilician — SP 66/1
12. Treasurer — SP 150/1
13. High King — SP 50/1
14. The Harv — SP 50/1
15. Easy Answer — SP 100/1
16. The Scallionator — SP 80/1
17. Ruler's Pride — SP 13/2
18. Siouxperb — SP 12/1
19. God Given Talent — SP 25/1
20. Bull Shark — SP 100/1
21. The Ginger Kid — SP 22/1

Note: result data provided currently includes positions 1–21 only; no 22nd finisher supplied.

### Model Result
- Model pick: Confucius
- Finish position: 6th
- Outcome: Lost
- Stake: 8.38
- P/L: -8.38

### Pre-Race Signal Review
- Confucius was model pick and market favourite.
- EV: +21.7%
- Confidence: Low
- Data quality: DEGRADED
- Tipsters: DIVERGENT

### Validation Note
The fuller Coventry result confirms Confucius finished 6th. The model pick lost. Pre-race warnings were important: confidence was low, data quality was degraded, and tipsters were divergent. Great Barrier Reef, which had public/tipster support, won.

---

## Accuracy After Race 2 Import

### API Check
- Races settled: 2
- Recommendations total: 7
- Settled count: 2
- Pending count: 5
- Winners: 0
- Losers: 2
- Strike rate: 0%
- Profit/loss: -10.5892
- ROI: -100%
- Total staked: 10.5892
- Average EV: 0.1272
- No-bet races: 0

### Interpretation
Both settled model picks have lost so far:
- 14:30 Queen Anne: Docklands lost
- 15:05 Coventry: Confucius lost

The manual import and accuracy/performance panels are working correctly. The performance block is the key staking-based result.

---

## 15:40 — King Charles III Stakes

### Official Result
1. Mission Central — SP 14/1
2. Rayevka — SP 7/1
3. Overpass — SP 10/3 Fav
4. Rosy Affair — SP 18/1
5. Jakajaro — SP 33/1
6. Heavenly Heather — SP 40/1
7. Asfoora — SP 12/1
8. Big Mojo — SP 11/1
8. Miss Attitude — SP 80/1 — dead heat
10. Night Raider — SP 4/1 2Fav
11. Jm Jungle — SP 80/1
12. Azure Angel — SP 125/1
13. Cover Up — SP 25/1
14. Mgheera — SP 80/1
15. Ain't Nobody — SP 80/1
16. Aspect Island — SP 40/1
17. Shagraan — SP 66/1
18. Behike — SP 33/1
19. Time For Sandals — SP 16/1
20. Frost At Dawn — SP 50/1
21. Getreadytorumble — SP 66/1
22. First Instinct — SP 66/1
23. Starlust — SP 50/1
24. Monteille — SP 66/1
25. Rumstar — SP 25/1
26. American Affair — SP 15/2

### Model Result
- Model pick: Night Raider
- Finish position: 10th
- Outcome: Lost
- Stake: 1.48
- P/L: -1.48

### Pre-Race Signal Review
- Night Raider was the model pick.
- EV: +14.8%
- Confidence: Low
- Data quality: DEGRADED
- Tipsters: DIVERGENT
- Market favourite was Overpass, who finished 3rd.
- Winner was Mission Central.
- Rayevka was the #2 model alternative and finished 2nd.
- Night Raider shortened/went off as 4/1 2Fav but finished 10th.

### Validation Note
Race 3 winner was Mission Central. The model pick Night Raider did not win and finished 10th. The pre-race warning flags were again important: confidence was low, data quality was degraded, and tipsters were divergent from the model recommendation. The model's #2 alternative Rayevka ran well and finished 2nd, but the persisted recommendation still lost.

---

## 16:20 — St James's Palace Stakes

### Official Result
1. Bow Echo — SP 5/6 Fav
2. Gstaad — SP 2/1 2Fav
3. Talk Of New York — SP 11/2
4. Power Blue — SP 50/1
5. Lord Britain — SP 100/1
6. Puerto Rico — SP 16/1

### Model Result
- Model pick: Talk Of New York
- Finish position: 3rd
- Outcome: Lost
- Stake: 4.71
- P/L: -4.71

### Pre-Race Signal Review
- Talk Of New York was the model pick.
- EV: +25.7%
- Confidence: Low
- Data quality: OK
- Tipsters: DIVERGENT
- Market favourite was Bow Echo, who won.
- Gstaad was the #2 model alternative and finished 2nd.
- Power Blue was the #3 model alternative and finished 4th.
- The model's top three noted runners filled 2nd, 3rd, and 4th, but the persisted recommendation still lost because Bow Echo won.

### Validation Note
Race 4 winner was Bow Echo. The model pick Talk Of New York did not win and finished 3rd. This was the cleanest data-quality setup so far because data quality was OK, but the tipster layer was still divergent and the model was opposing a short-priced market favourite. The result suggests the model identified contenders around the winner but still missed the winning favourite.

---

## Accuracy After Race 4 Import

### API Check
- Races settled: 4
- Recommendations total: 7
- Settled count: 4
- Pending count: 3
- Winners: 0
- Losers: 4
- Strike rate: 0%
- Profit/loss: -16.7749
- ROI: -100%
- Total staked: 16.7749
- Average EV: 0.1494
- No-bet races: 0

### Interpretation
The first four persisted model recommendations have all lost:
- 14:30 Queen Anne: Docklands lost
- 15:05 Coventry: Confucius lost
- 15:40 King Charles III: Night Raider lost
- 16:20 St James's Palace: Talk Of New York lost

The manual results importer and accuracy/performance panels are functioning correctly. The model has not performed well so far, and the repeated LOW confidence / divergent tipster warnings should be reviewed after the day.

---

## 17:00 — Ascot Stakes

### Official Result
1. Kizlyar — SP 25/1
2. Defiantly — SP 25/1
3. Tim Toe — SP 8/1
4. Barnso — SP 40/1
5. Annabel's Ghost — SP 40/1
6. Small Fry — SP 12/1
7. Galileo Dame — SP 14/1
8. Beylerbeyi — SP 25/1
9. All In You — SP 16/1
10. Bahadur — SP 14/1
11. Comfort Zone — SP 25/1
12. Bunting — SP 14/1
13. Westminster Moon — SP 20/1
14. Lavender Hill Mob — SP 50/1
15. Mordor — SP 33/1
16. Puturhandstogether — SP 5/1 2Fav
17. Siempre Arturo — SP 40/1
18. Ismahane — SP 33/1
19. Glenroyal — SP 25/1
20. Reaching High — SP 13/8 Fav

### Model Result
- Model pick: Small Fry
- Finish position: 6th
- Outcome: Lost
- Stake: 1.20
- P/L: -1.20

### Pre-Race Signal Review
- Small Fry was the model pick.
- EV: +16.6%
- Confidence: Low
- Data quality: DEGRADED
- Tipsters: DIVERGENT
- Market favourite was Reaching High, who finished 20th.
- Winner was Kizlyar.
- Tim Toe was the #3 model alternative and finished 3rd.
- Puturhandstogether was the #2 model alternative and finished 16th.

### Validation Note
Race 5 winner was Kizlyar. The model pick Small Fry did not win and finished 6th. The model correctly discounted the short-priced favourite Reaching High, who finished 20th, but it did not find the winner. The race again had LOW confidence, degraded data due to one missing runner price, and divergent tipster consensus, so the pre-race warning flags were important.

---

## 17:35 — Wolferton Stakes

### Official Result So Far
1. Map Of Stars — SP 13/2
2. Wimbledon Hawkeye — SP 12/1
3. Dividend — SP 33/1
4. Galen — SP 16/1

Note: result data provided currently includes top 4 only; no remaining finishing positions supplied yet.

### Model Result
- Model pick: Ghostwriter
- Finish position: Not provided
- Outcome: Lost
- Stake: 1.00
- P/L: -1.00

### Pre-Race Signal Review
- Final 5-minute model pick was Ghostwriter.
- EV: +13.0%
- Confidence: Low
- Data quality: DEGRADED
- Tipsters: NO_TIPSTER_CONSENSUS
- Market favourite was Map Of Stars, who won.
- Map Of Stars was the #2 model alternative in the final snapshot and won.
- Earlier snapshots had Map Of Stars and Haatem as model picks, but the final close pre-race snapshot changed to Ghostwriter.

### Validation Note
Race 6 winner was Map Of Stars. The final persisted/recorded model pick Ghostwriter did not win, so the race is counted as a model loss unless the stored recommendation differs. The model’s #2 alternative and market favourite Map Of Stars won, showing the model had the winner nearby in the ranked alternatives but the final recommendation still missed. Confidence was Low, data quality was degraded, and there was no tipster consensus, so the warning flags remained important.

---

## 18:10 — Copper Horse Stakes

### Official Result
1. Daiquiri Bay — SP 6/1
2. Gamrai — SP 9/2 2Fav
3. Paddy The Squire — SP 22/1
4. Aeronautic — SP 12/1
5. Sing Us A Song — SP 6/1
6. Valiancy — SP 9/4 Fav
7. Ernst Blofeld — SP 14/1
8. Incensed — SP 40/1
9. Enemy — SP 50/1
10. Ascending — SP 6/1
11. Stressfree — SP 22/1
12. Hallelujah U — SP 28/1
13. Real Dream — SP 25/1
14. Yashin — SP 50/1
15. Duraji — SP 25/1
16. Green Cape — SP 50/1

### Model Result
- Model pick: Gamrai
- Finish position: 2nd
- Outcome: Lost
- Stake: 1.00
- P/L: -1.00

### Pre-Race Signal Review
- Gamrai was the model pick.
- EV: +6.1%
- Confidence: Low
- Data quality: OK
- Tipsters: DIVERGENT
- Market favourite was Valiancy, who finished 6th.
- Winner was Daiquiri Bay.
- Gamrai finished 2nd and was beaten by a head.
- Sing Us A Song was the #3 model alternative and finished 5th.
- Valiancy was the #2 model alternative and finished 6th.

### Validation Note
Race 7 winner was Daiquiri Bay. The model pick Gamrai did not win but ran very close, finishing 2nd by a head. This was one of the cleaner data-quality races because data quality was OK, but confidence remained Low and tipsters were divergent. The model successfully opposed the beaten favourite Valiancy but narrowly missed the winner.


