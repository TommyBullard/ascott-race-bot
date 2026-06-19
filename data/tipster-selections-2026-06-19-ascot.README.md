# Tipster selections — 2026-06-19 Ascot (fill-in template)

This is a **fill-in template** for `import:tipster-selections`. The example rows
use **real 2026-06-19 Ascot runners** (so you can see the matching work in a
dry-run), but every `tipster_name` / `source_label` contains the word **EXAMPLE**,
so the importer **refuses to `--commit`** until you replace them with real picks.

> **Do not fabricate selections.** Replace the EXAMPLE rows with **real** tipster
> picks from **licensed / ToS-compliant** sources only. Do not scrape paywalled
> or restricted sites. Unmatched/ambiguous rows are skipped, never guessed.

## Columns (header required)

| Column | Required | Notes |
| --- | --- | --- |
| `meeting_date` | yes | `2026-06-19` |
| `course` | yes | `Ascot` (normalised match) |
| `off_time` | yes | `HH:MM` **UTC** (e.g. `13:30`) — composed as `<date>T<off>:00Z` |
| `horse_name` | yes | must match a real runner in that race (normalised) |
| `tipster_name` | yes | the real tipster; unresolved names are stored with `tipster_id = null` (raw name kept) |
| `raw_affiliation` | no | the tipster's site/affiliation |
| `source_label` | no | provenance tag, e.g. `manual-2026-06-19` |

One row per **(tipster, race, horse)** pick. Multiple tipsters backing the same
horse in a race is how a **consensus** forms (and clears `NO_TIPSTER_CONSENSUS`).

## Workflow (safe, dry-run first)

```bash
# 0. (optional) list today's races to confirm off-times:
npm run import:tipster-selections -- --list-races --date 2026-06-19 --course Ascot

# 1. DRY-RUN the template (read-only — matches races/runners, writes nothing):
npm run import:tipster-selections -- --file data/tipster-selections-2026-06-19-ascot.csv

# 2. Replace the EXAMPLE rows with REAL tipster picks (keep real runner names).

# 3. DRY-RUN again — confirm matched count + 0 skipped:
npm run import:tipster-selections -- --file data/tipster-selections-2026-06-19-ascot.csv

# 4. WRITE — only after validation (the EXAMPLE guard must be cleared):
#    WRITE / MANUAL APPROVAL REQUIRED:
npm run import:tipster-selections -- --file data/tipster-selections-2026-06-19-ascot.csv --commit

# 5. Verify consensus would form (read-only):
npm run verify:tipster-match -- --date 2026-06-19 --course Ascot

# 6. The next model run consumes the selections (append-only history handles re-runs).
#    Tipster selections are model-active: matched picks move model probabilities
#    (quality-weighted by tipster_priors when present, else a neutral 0.5).
```

Importing selections changes **no** model math, staking, or recommendation
logic, and adds **no** auto-betting — it only supplies the inputs the existing
engine already reads.
