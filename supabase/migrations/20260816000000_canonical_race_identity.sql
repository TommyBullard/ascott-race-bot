-- Migration: canonical race identity + future-data capture (Programme 0).
--
-- ADDITIVE ONLY, FUTURE-DATA ONLY. Every statement below is an
-- "add column if not exists" or an "add index if not exists". Nothing is
-- dropped, renamed, merged, defaulted, backfilled or rewritten, and no
-- historical row is touched. Applying this migration changes no existing value
-- and no application behaviour on its own: the columns are written only by
-- FUTURE racecard ingestion, in a separate operator-controlled action.
--
-- WHY THIS EXISTS. The read-only production audit established that the app
-- stores no provider identity at all: races are matched on a normalised
-- (course + off-time) pair and runners on a normalised horse name. That is
-- adequate for same-day operation but it cannot support stable, bookmarkable
-- race URLs, and it silently discards race attributes the provider already
-- returns on every racecard (going, distance, class, type, age band, pattern,
-- field size). Those attributes are the entire feature surface a market-blind
-- model would need. This migration creates somewhere to put them.
--
-- IDENTITY MODEL — three distinct things, deliberately not conflated:
--
--   races.id            INTERNAL identity. The existing uuid primary key and
--                       the relational backbone for runners, model_runs,
--                       recommendations and locked_race_decisions. UNCHANGED
--                       by this migration and never rewritten.
--   provider_race_id    EXTERNAL identity. The Racing API `race_id` for the
--                       card this row came from. Nullable, non-unique for now:
--                       every one of the 719 existing races predates capture,
--                       so uniqueness cannot be asserted until future coverage
--                       is observed.
--   race_slug           ROUTE identity. A human-readable URL handle assigned
--                       at first insert and not rewritten afterwards by any
--                       current write path. Not a key, not unique yet, never
--                       used to join, and NOT a guarantee of one URL per real
--                       race -- see the race_slug column note below.
--
-- WHAT IS DELIBERATELY NOT HERE:
--   - No NOT NULL on any new column (historical rows stay null = "unknown").
--   - No UNIQUE constraint on provider_race_id or race_slug. Uniqueness is a
--     claim about data we do not yet have; asserting it now would make the
--     first duplicate an outage.
--   - No DEFAULT on any new column. A default would write a value into 719
--     historical rows that no provider ever told us, which is fabrication.
--     is_abandoned is left null ("unknown") rather than false for exactly this
--     reason -- current ingestion SKIPS abandoned cards entirely, so no stored
--     row has ever been evaluated for abandonment.
--   - No trigger, no backfill, no conflict-target change.
--   - No foreign key to any provider id (they are external strings, not keys).
--   - No change to runner_quotes (the snapshot_id / market_snapshot_id
--     reconciliation belongs to the as-of integrity programme).
--   - No change to either handicap column. handicap_flag remains the active
--     field; is_handicap is legacy and stays untouched.
--
-- Decision-support only. Nothing here places, recommends or settles a bet.

-- ---------------------------------------------------------------------------
-- races: provider identity, route identity, and the discarded card attributes
-- ---------------------------------------------------------------------------

-- EXTERNAL identity from The Racing API (`race_id`, e.g. the "rac_"-prefixed
-- handle). Text because it is an opaque provider string, not a uuid we mint.
alter table public.races add column if not exists provider_race_id text;

-- The provider's own course handle (`course_id`). Stored alongside, never
-- instead of, the human-readable `course` label the dashboard displays.
alter table public.races add column if not exists provider_course_id text;

-- ROUTE-SAFE course key derived deterministically from `course` by the pure
-- helper in src/lib/raceSync.ts (courseKey). Lower-case, hyphenated, "(AW)"
-- stripped, established aliases applied. Deliberately a SEPARATE column from
-- `course` so the display label stays free to change without moving a URL.
alter table public.races add column if not exists course_key text;

-- ROUTE-SAFE race handle: a NULLABLE route handle assigned to newly inserted
-- rows (scheduled HHMM + slugified race name). Programme 0 performs no
-- historical backfill, so all 719 existing races keep a null slug.
--
-- SCOPE OF THE GUARANTEE. Current write paths do not update a slug already
-- stored on a row: racecard ingestion inserts only when the lookup misses, and
-- settlement writes only status and official_result_time. That is per-row
-- immutability.
--
-- Programme 0 does NOT guarantee one row, or one URL, per real race across a
-- provider off-time correction or a course-label correction: resolution still
-- uses the raw course string plus off_time, so a corrected card can insert a
-- second row with its own slug. Capturing provider identity and RESOLVING on
-- provider identity are separate things, and this migration does only the
-- first. Not unique yet -- see the header.
alter table public.races add column if not exists race_slug text;

-- Provider race type vocabulary (e.g. Flat / Hurdle / Chase). The single field
-- that makes Flat / Jumps / All-Weather specialisation possible at all. Text
-- because the provider vocabulary is not fixed by this repository.
alter table public.races add column if not exists race_type text;

-- Numeric race distance in FURLONGS, for modelling. Deliberately separate from
-- the existing human-readable `races.distance`: one is a number you can put in
-- a model, the other is a string you can put on a page. Neither replaces the
-- other and this migration does not touch `distance`.
alter table public.races add column if not exists distance_f numeric;

-- Provider age band (e.g. "3yo+"). Text: an eligibility expression, not a number.
alter table public.races add column if not exists age_band text;

-- Provider pattern/grade (e.g. Group 1, Listed). Drives major-event prominence
-- in the future navigation programme.
alter table public.races add column if not exists pattern text;

-- Declared field size as stated on the card. NOT a substitute for counting
-- runners rows -- it is the provider's own figure at card time, which is the
-- correct value for an as-of feature.
alter table public.races add column if not exists field_size integer;

-- Provider abandonment flag. Left null on every existing row on purpose: see
-- the header note. Current ingestion never stores an abandoned card, so a
-- populated `false` here means "the provider explicitly said not abandoned",
-- and null means "never recorded".
alter table public.races add column if not exists is_abandoned boolean;

-- ---------------------------------------------------------------------------
-- runners: provider identity only
-- ---------------------------------------------------------------------------

-- EXTERNAL horse identity (`horse_id`). This is what eventually makes prior-run
-- form linkage possible; today the app matches runners on a normalised name,
-- which cannot survive a renamed or ambiguously-spelled horse.
--
-- trainer_id, jockey_id and age are deliberately NOT added here: the audit
-- confirmed all three already exist on this table (unpopulated). Programme 0
-- starts writing them from ingestion rather than duplicating the columns.
alter table public.runners add column if not exists provider_horse_id text;

-- ---------------------------------------------------------------------------
-- indexes
-- ---------------------------------------------------------------------------

-- PARTIAL and NON-UNIQUE, on purpose.
--
-- Partial: every existing row is null, so a full index would be almost entirely
-- dead entries. Non-unique: uniqueness is exactly the property we have not yet
-- earned the right to assert. When future ingestion has produced enough rows,
-- a follow-up migration can verify uniqueness against real data and only then
-- promote this to a unique index -- a separate, evidenced decision.
create index if not exists races_provider_race_id_idx
  on public.races (provider_race_id)
  where provider_race_id is not null;

-- Column comments: keep the three identity kinds distinguishable in psql/Studio,
-- where this file's header is not visible.
comment on column public.races.provider_race_id is
  'External Racing API race id, nullable because historical rows predate capture. Not a key. races.id remains the internal identity.';
comment on column public.races.race_slug is
  'Route-safe URL handle assigned to newly inserted rows. Not rewritten by current write paths, but not a guarantee of one row or one URL per real race across off-time or course-label corrections. Not a join key.';
comment on column public.races.course_key is
  'Route-safe normalised course key derived from course by the courseKey helper in src/lib/raceSync.ts. Display label stays in races.course.';
comment on column public.races.distance_f is
  'Race distance in furlongs, numeric, for modelling. Separate from the human-readable races.distance string.';
comment on column public.races.is_abandoned is
  'Provider abandonment flag. Null means never recorded, because current ingestion skips abandoned cards entirely.';
comment on column public.runners.provider_horse_id is
  'External Racing API horse id, nullable because historical rows predate capture. Runner matching still uses the normalised horse name.';
