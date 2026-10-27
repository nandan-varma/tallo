# Architecture

## Goals and non-goals (v1)

Browse jobs from ~9k company boards (the database stores what they state; the AI assistant judges fit), refreshed daily from this
Mac, hosted cheaply on Cloudflare (about $5/month). Not in v1: public traffic, SEO, accounts,
personal fit/resume features, vector search, closed-job history.

## Boundaries

1. **Source evidence**: what a source returned (raw payloads, per run, short retention).
2. **Shared catalog**: normalized, personal-free jobs. Lean rows in D1.
3. **Personal layer** (v2): preferences, saved jobs, fit assessments, resumes. Separate tables per user.

Package boundaries are not deployment boundaries: one Worker serves the API, one serves the web UI.

## Collection

A _source_ is one configured board (`platform:key`). A _platform_ module implements:
- `list(source, ctx)`: stream listing rows, returns `{complete, emptyIsAuthoritative}`.
- `detail?(source, posting, ctx)`: extra per-posting payload (e.g. Greenhouse pay ranges, Workday description).
  Only called for postings whose fingerprint changed, so daily runs stay cheap.
- `fingerprint?(listing)`: the part of a listing that signals a real change (Workday drops "Posted 3 days ago").
- `map(raw, source)`: pure conversion to `MappedJob`.

Everything the source returns is kept in `RawPosting {id, listing, detail}` and shipped to R2 as the run's
raw pack. `tallo verify <source>` dry-runs a source and lists fields `map` never reads.

`packages/http` is the only network code: https only, host allowlist per platform, private-address block,
redirect re-checks, response size caps, retries with `Retry-After`, per-host concurrency/interval.

### Platform notes

- **Greenhouse**: one list call returns every job with content; pay transparency and questions need the detail call.
- **Lever / Ashby**: the list call is complete (descriptions, pay when published). Ashby unlisted rows are dropped.
- **SmartRecruiters**: paged list (100) plus per-posting detail for the job ad sections.
- **Workday**: every query is capped at 2,000 results. The collector splits capped slices by facet
  (state, job family, ...) recursively and dedupes by `externalPath`. A slice that cannot be split reports
  `complete: false`, which blocks closure.

## Ingest protocol (runner → API)

1. `POST /v1/runs` start (idempotent on `runId`; one running run per source, stale after 2h).
2. List, then `POST /v1/runs/:id/diff` with `{id, sourceHash}` for every listed posting. `sourceHash` =
   sha256(fingerprint + platform version). Server answers which are new/changed.
3. Detail + map + `prepareJob` for changed postings only (Mac CPU, free).
4. `POST /v1/blobs/check`, `PUT /v1/blobs/jd/:hash` for missing descriptions (hash verified server-side).
5. `POST /v1/runs/:id/jobs` in batches of ≤100 (upsert; refuses jobs whose blob is missing).
6. `PUT /v1/runs/:id/raw` the run's raw pack of changed postings.
7. `POST /v1/runs/:id/finalize` with every listed id and completeness flags. Server applies closure.

Runs are recorded (`runs` table: runner id, collector version, counts, issues) so it is always clear
what ran where and when. Failures finalize the run as `partial`; nothing is inferred from them.

## Lifecycle

- Seen in a complete listing: `absent_runs = 0`, reopened if closed.
- Missing from a complete, non-empty (or authoritatively empty) listing: `absent_runs += 1`; at 2, `closed_at` is set.
- `updated_at` moves only when the row's duplicate group can change: it is inserted, its `dedupe_key` changes, it closes or
  it reopens. Other edits (location, pay, a first absence) leave it alone, so the hourly regroup window stays small.
- Closed jobs are purged (rows and orphaned description blobs) 30 days later by the Worker's hourly cron.
- A source with no complete run for 7 days is flagged stale (`sources.last_complete_run_at`); hiding stale
  sources' jobs is a read-side policy (planned, see issues).
- No per-job `last_seen` writes: presence is derived from set difference per complete run.

## Data model (D1, `packages/db/src/schema.ts`)

- `sources`: configured boards + last run status, consecutive 404 count and `active`/`dead` status.
- `runs`: bounded operational history.
- `jobs`: hot narrow row: identity (`source_id`, `posting_id`), display facts as the source stated them (location
  text, city/region/country code when the source gives them, work mode, department, employment type, dates), `jd_hash`,
  `source_hash`, `facts` JSON (all locations, pay components in their own interval, experience, extras), lifecycle
  fields, `dedupe_key`/`dup_of`. There are no derived columns: no pay or experience columns, no US/tech flags, no hidden flag.
- `jobs_fts`: FTS5 over title, company, location (external-content, trigger-maintained). No descriptions.

Location display text is bounded to 500 characters; city/region values over 120 characters stay NULL
in indexed columns. Full location values remain in `facts.locations` and raw evidence. This keeps
malformed source place fields from rejecting otherwise valid job batches.

Quantities keep source semantics: "3+ years" is `{min: 3, kind: required}`, never a range or midpoint. Pay
components keep currency, the interval the source states (never annualized), component type and region. Unknown stays
NULL. Nothing is parsed from text: no heuristics in the database (see `decisions.md` D6). The one derived string is the
result's `pay` line: the first base pay the source stated with a rate interval, e.g. "USD 90000-95000 per hour".
`inferred` on a value marks text-parsed data; no platform sets it today and the pay line never uses it.

### Personal layer

`profiles` (the person's free-text notes for the assistant), `applications` (the tracker; a snapshot of the posting is
copied in because postings are purged after closing), `searches` (saved searches, `seen_at` drives "N new") and `resumes`
(structured resume JSON, one row per user and posting; `job_id` 0 is the base resume, no foreign key so a copy outlives its posting). Neither is ever joined
into catalog tables; `listResumes` looks up posting titles in a second query. v1 has one user (`DEFAULT_USER`).

## API layout

`apps/api/src/app.ts` only mounts: `jobs.ts` (catalog reads), `assistant.ts` (chat, notes, the model getter), `applications.ts`,
`searches.ts`, `resume.ts` (resume CRUD and the AI calls: import, tailor, edit, cover letter, fit, prep) and `ingest.ts`
(runner protocol, admin). Every AI route goes through `resumeAi`/`assistant()`, so a missing key is a 503 and a model
failure is a 502 with only the error name logged.

## Resume builder

`/resume` (base) and `/resume/<posting id>` (tailored copy; `?tailor=1` tailors on arrival) are one React island,
`ResumeWorkspace`: section editor, assistant panel, live PDF. Autosave is debounced, one write at a time
(`useResumeDoc`). API: `GET/PUT/DELETE /v1/resume[?job=]`, `GET /v1/resumes`, and `POST /v1/resume/{import,tailor,edit}`
(`packages/resume/ai`, one `generateText` + `Output.object` each; the posting's description is read from R2, never fetched
from a user URL). The web `/api/resume*` routes only relay with a byte cap (`lib/proxy.ts`). Rendering lives in
`apps/web/src/lib/resume` (`pdf.tsx` document, `layout.ts` densities and font-safe text, `render.ts` fitting).

## Search

`GET /v1/jobs`: FTS prefix match (`q` is required), newest first, keyset pagination on `(sort_at, id)`. There is no unfiltered
feed: without `q` it would scan and sort every open job, and no index serves it (the feed and company indexes were dropped).
The planner reads the FTS table for `q` and sorts the matches (checked on production with EXPLAIN QUERY PLAN).
The assistant's results list is a ranked search (`rankedJobs`): title phrases ORed in one FTS MATCH, places and companies
ANDed, the best 2000 candidates by bm25 (title x10, company x2, location x1), collapsed to one row per company and title,
paged by offset up to 300. Visibility is one predicate (`visibleJobs`): open, canonical (`dup_of IS NULL`), from a source
that listed within 14 days. There are no other filters; the assistant narrows by title phrases, companies and places
(`docs/ai-search.md`). Search sits behind these query functions; vector/context search will be another implementation
of the same query surface.

## Cost (10 daily users, ~300k stored jobs)

Workers Paid $5 + domain; D1 and R2 stay inside included allowances. AI enrichment is the real cost risk
and is opt-in (see decisions).

### D1 rows read and written: duplicate groups (estimates)

Open rows about 487k (production read-only count, Oct 26, 2026; the count moves with syncs). Estimates; the method and assumptions are in `docs/ai-search.md`.

| Work                                                                                               | Rows read                                                                     | Rows written                                     |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------ |
| Hourly regroup, quiet hour (`sources` scan, then `jobs_source_posting_idx` and `jobs_updated_idx`) | about 9k: the scan of 8,895 boards (measured), plus a few hundred window rows | 0                                                |
| Hourly regroup, busy hour                                                                          | about 15k to 25k                                                              | rows whose `dup_of` changed                      |
| Hourly regroup, before the stale branch fix (`jobs_dedupe_idx` walk, `sources` lookup per row)     | about 0.95M per pass, about 23M per day                                       | regroup only                                     |
| Hourly window without `jobs_updated_idx` (full scan, estimate)                                     | about 0.5M per pass, about 12M per day                                        | regroup only                                     |
| Finalize regroup, per daily sync (source's rows)                                                   | about 0.47M per day                                                           | 0 in steady state                                |
| One-off backfill (`tallo dedupe`, id cursor)                                                       | about 0.47M                                                                   | about 0.94M (row and index entry)                |
| One-off full regroup (`tallo dedupe`)                                                              | about 0.87M                                                                   | about 0.14M (about 68k rows, plus index entries) |

The index `jobs_updated_idx` costs one index entry per row whose group can change (see Lifecycle) and saves roughly 12M reads
per day (estimate). D1 writes are the scarcer allowance, so the index is cheap on writes too: writes scale with changed
postings, not with the catalog. The one-off backfill is about 0.94M writes, roughly 2% of the monthly included writes.

### Write cost per posting (local harness, 100 postings)

Scenario on SQLite (`testDb`): 100 postings are new, then re-applied unchanged, then re-applied with every title changed,
then listed once (99 absent), then listed again (99 close), then purged 30 days later. The table is from a scratch run of
that scenario; `packages/db/test/write-cost.test.ts` asserts each behavior it depends on. `testDb().writeCost` counts
the way below (`writeCost(db)` in `testing.ts`). `rows` is every row SQLite changed,
triggers included (`total_changes`). `index` is index entries written, as EXPLAIN says each statement opens them: it
over-counts partial indexes (a partial index is written only for rows that match its WHERE). Production's rows_written
also counts index entries; these numbers are relative, not D1 billing.

| Work                              | Before (rows / index) | After (rows / index) | What changed                                                            |
| --------------------------------- | --------------------- | -------------------- | ----------------------------------------------------------------------- |
| New postings                      | 9.1 / 6.0             | 9.1 / 6.0            | Feed and company indexes replaced by `jd_hash` and closed indexes       |
| Identical postings re-applied     | 11.3 / 6.0            | 0.02 / 0.02          | Unchanged postings are not rewritten; no FTS write                      |
| Title changed                     | 11.1 / 6.0            | 11.3 / 6.0           | FTS rewrite stays (the title changed); dedupe key moves, updated_at too |
| First absence (99 of 100 missing) | 1.0 / 4.0             | 1.0 / 0.02           | `absent_runs` only; no index, no updated_at                             |
| Second absence (closes 99)        | 1.0 / 4.0             | 1.0 / 3.0            | Closing sets closed_at and updated_at (regroup input)                   |
| Purge of 99 closed postings       | 3.4 / 5.9             | 3.0 / 5.9            | Reads change, see below; the index metric does not show the new entries |

Per posting in production terms: an open new job writes the source/posting, dedupe, updated_at and `jd_hash` index entries
(about 4 real entries), where it wrote 5 before (feed and company indexes are gone). A first absence writes no index entry.
The purge is the cost that goes up: each purged row now also leaves a `jd_hash` entry and a `closed_at` entry
(about 2 more index entries per purged row). In exchange, a purge pass no longer reads the whole table.

### Purge reads (production, EXPLAIN QUERY PLAN, Oct 26, 2026)

| Lookup                                        | Before (plan on production)                                     | After (local plan; re-check on production after migration 0014) |
| --------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| Closed rows older than 30 days (`LIMIT 1000`) | `SCAN jobs` (508k rows read every hourly pass)                  | `SEARCH jobs USING INDEX jobs_closed_idx` (closed rows only)    |
| Is a hash still referenced, one per hash      | `SCAN jobs` per hash (about 508k rows each)                     | one statement per 100 hashes, `SEARCH` via `jobs_jd_hash_idx`   |
| Same, batched (100 hashes in one statement)   | `SCAN jobs` (about 508k rows per statement), not an improvement | seeks: about 100 index entries plus the matching rows           |

Batching alone does not help: the batched statement still scans `jobs` on the current schema. The index is what makes
the lookup cheap. Both new indexes are kept because the alternative is a table scan on every hourly pass that purges
anything (about 12M rows read per day), while the index costs one write per new description and per purged row.
