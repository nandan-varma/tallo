# Architecture

## Goals and non-goals (v1)

Browse US tech jobs from ~9k company boards with simple search and filters, refreshed daily from this
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
- Closed jobs are purged (rows and orphaned description blobs) 30 days later by the Worker's hourly cron.
- A source with no complete run for 7 days is flagged stale (`sources.last_complete_run_at`); hiding stale
  sources' jobs is a read-side policy (planned, see issues).
- No per-job `last_seen` writes: presence is derived from set difference per complete run.

## Data model (D1, `packages/db/src/schema.ts`)

- `sources`: configured boards + last run status.
- `runs`: bounded operational history.
- `jobs`: hot narrow row: identity (`source_id`, `posting_id`), display facts, typed filters (country, work mode,
  department, pay annualized, experience years), tri-state `is_us`/`is_tech`, `hidden` (confident out-of-scope),
  `jd_hash`, `source_hash`, `facts` JSON (all locations, pay components, experience, extras), lifecycle fields.
- `jobs_fts`: FTS5 over title, company, location (external-content, trigger-maintained). No descriptions.

Location display text is bounded to 500 characters; city/region values over 120 characters stay NULL
in indexed columns. Full location values remain in `facts.locations` and raw evidence. This keeps
malformed source place fields from rejecting otherwise valid job batches.

Quantities keep source semantics: "3+ years" is `{min: 3, kind: required}`, never a range or midpoint. Pay
components keep currency, interval, component type and region. Inferred values (parsed from text) carry
`inferred: true`; structured values always win. Unknown stays NULL.

Heuristics (`catalog/classify.ts`, versioned): `is_us` is 1 if any location is US, 0 only if every
location is known and non-US, else NULL. `is_tech` is 1 for tech titles/departments, 0 only when confidently
non-tech, else NULL. Only confident zeros hide a job; unknown stays visible. Retained raw packs let a
corrected rule be replayed without refetching.

## Search

`GET /v1/jobs`: FTS prefix match plus filters, keyset pagination on `(sort_at, id)`, partial indexes on
`closed_at IS NULL AND hidden = 0`. Search sits behind `searchJobs`; vector/context search will be another
implementation of the same query surface.

## Cost (10 daily users, ~300k stored jobs)

Workers Paid $5 + domain; D1 and R2 stay inside included allowances. AI enrichment is the real cost risk
and is opt-in (see decisions).
