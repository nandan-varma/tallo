# Architecture

## Goals and non-goals (v1)

Public, read-only job search over ~9k company boards (the database stores what they state; the reader judges fit),
refreshed daily from this Mac, hosted cheaply on Cloudflare (about $5/month). The web offers a home page and `/search`;
each result links to the employer's application. Not planned: accounts, any per-person data, AI in the product, SEO
work, vector search, closed-job history. See `decisions.md` D15.

## Boundaries

1. **Source evidence**: what a source returned (raw payloads, per run, short retention).
2. **Catalog**: normalized jobs with what each source stated. Lean rows in D1.
3. **Read surface**: the API's job reads and the web search pages, both over the catalog only.

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

## Where collection runs

Collection runs in the `tallo-api` Worker, from a queue. The Mac runner can still collect by hand (`tallo sync`)
with the same code (`packages/collect`), and it writes through the same HTTP ingest protocol below.
- **Schedule (D1)**: `sources.next_due_at` (epoch seconds) and `sources.tier` (`hot`, `normal`, `rare`). Every board is
  collected once a week (`normal`, `rare`). Boards in `sources/hot.json` are `hot` and collected daily. A seen-dead board
  waits 30 days. A failed or partial run backs off 1h, 3h, 6h, then 24h for each further failure in a row
  (`sources.failure_count`; a complete run resets it), so a transient failure does not cost a week and a board that
  always fails costs one request a day. A board that has never listed anything waits 30 days after ten failures, and
  stays active. The policy is one pure function (`packages/contracts/src/schedule.ts`).
- **Claim (cron, every 5 minutes; currently not scheduled, cloud collection is off since 2026-11-21)**: one statement moves up to `COLLECT_BATCH` (default 40) due boards' `next_due_at`
  forward by a 30-minute lease and returns them. Each becomes one `start` message on the queue `tallo-collect`. Two
  claimers never get the same board. A crashed collector frees its boards when the lease ends. The cron does nothing
  unless `COLLECT_ENABLED` is `"1"` (the kill switch). Boards with `params.egress: "local"` are never claimed, by the cron
  or by name: they need the Mac's egress (see the runbook, "Boards that need the Mac's egress").
- **Queue consumer**: one board per invocation (`max_batch_size` 1, `max_concurrency` 4, `max_retries` 2, then the
  dead-letter queue `tallo-collect-dlq`). It calls the same engine as the runner (`begin`, `advance`, `complete` in
  `packages/collect/src/engine.ts`) with the D1 and R2 bindings instead of HTTP.
- **Slices**: a board's detail work is cut into slices of at most 100 postings and 800 subrequests (wall time 5 minutes).
  A slice that stops early puts a `slice` message back on the queue with its progress (offset, counters, raw part keys).
  The plan (listing and diff) and the raw parts live in R2 under `work/<run>/` only for runs that continue past one
  slice; a run that finishes in its first slice writes no scratch. Closure happens only in the final
  slice, and only from a complete listing. A slice that throws is retried from the same offset, so a retry repeats the
  same postings. A run that is never finished stays `running` until the hourly reaper marks it partial. A reaped run counts as a failed run for its board
  (`failure_count` grows, `next_due_at` backs off; a dead board keeps its dead interval), but only when it is the
  board's latest run.
- **Per-host politeness**: `packages/collect/src/policy.ts` sets a concurrency and a start gap per platform. Public JSON
  boards (Greenhouse, Lever, Ashby, SmartRecruiters) use 8 in flight per host and no gap. Workday and Oracle Cloud use 2
  in flight and a 250 ms gap. The gap is enforced across invocations by a `HostGate` Durable Object per host (SQLite
  storage, one number: the next free time). Every gated request waits for a slot first; retries do not.
- **Failure kinds**: a 404 on a board's first request is `not_found` and counts toward dead (three in a row). A redirect
  off the host allowlist is `blocked` (issue code `blocked`): a failed run that never counts toward dead, because the
  source did not answer rather than saying it is gone. Only a successful listing resets the not-found streak.
- **Observability**: one JSON line per invocation (`source`, `platform`, `outcome`: `complete`, `partial`, `not_found`,
  `blocked`, `continued`, `busy`, `skipped`; `listed`, `changed`, `requests`, `subrequests`, `wall_ms`). Status (ingest token):
  `GET /v1/admin/collect/status` shows due counts by tier and platform, runs in flight, and the last 24 hours.
- **Admin**: `POST /v1/admin/sources` (registers reviewed configs and the hot list; `tallo register`),
  `POST /v1/admin/collect` with `{sources: [...]}` (collects named boards now, even with the cron off),
  `POST /v1/admin/sources/revive` with `{sources: [...]}` (clears dead status and the 404 streak; `tallo revive`), and
  `POST /v1/admin/sources/retire` with `{sources: [...], dryRun}` (removes a reviewed retired board's rows; `tallo
  retire`). All need the ingest token.

Limits: a Worker's subrequests per invocation are 10,000 on the paid plan; the slice budget is 800 so a slice has room.
R2 and D1 calls, Durable Object calls and every outbound request count against it. A listing is not sliced. If one
listing alone reaches the hard limit, the invocation throws, the message is retried and then dead-lettered, and the run
is reaped as partial (nothing closes). Such a board is collected by the Mac runner instead.

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

## API layout

`apps/api/src/app.ts` only mounts: `public.ts` (the public reads: `GET /v1/search`, `GET /v1/jobs/:id`,
`GET /v1/jobs/:id/description`, `GET /v1/companies`, `GET /v1/titles`, `GET /v1/openapi.json`, no auth), `ingest.ts`
(runner protocol, sources and runs, all INGEST_TOKEN) and `admin.ts` (board registration, staged collection).
`search.ts` holds the ranked search that `GET /v1/search` answers.

The public surface is GET-only and served through the web Worker, which keeps an allowlist, a per-address limit and an
edge cache in front of it (see `docs/runbook.md`, "Public API"). The response shapes, limits and cursor rules are defined
once in `packages/contracts/src/public-api.ts`; `/llms.txt` and `/v1/openapi.json` are generated from the same schemas.
Public answers are CORS-open (`*`) and answer `OPTIONS`: the reads are credential-free and GET-only. Discovery endpoints
read the small `companies` and `title_tokens` tables that `ingest.ts` maintains, never a scan of `jobs`.

## Search

The free-text feed (`GET /v1/jobs`) is retired: it was newest-first keyset paging over an FTS match, and nothing public needs
it. `GET /v1/search` is the public search. The results list is a ranked search (`rankedJobs`): title phrases ORed in one FTS MATCH, places and companies
ANDed, the best 2000 candidates by bm25 (title x10, company x2, location x1), collapsed to one row per company and title,
paged by offset up to 300. A hit's `locations` is the count of open `dup_of` siblings of that canonical row, this one
included, exactly the group `/v1/jobs/:id` lists as `variants`. Visibility is one predicate (`visibleJobs`): open,
canonical (`dup_of IS NULL`), from a source that listed within 14 days. There are no other filters; the query narrows by title phrases, companies and places.
The same search also takes `sort`: `recent` and `posted` order every open location by `sort_at, id` (the stated posted
date, else first seen), `posted` adds `posted_at IS NOT NULL`, and `added` orders by `id`; all three skip the bm25
candidate cut and the duplicate collapse. Two structured filters, `country` and `postedWithin`, apply to every sort and
are bound into the cursor checksum: `country` keeps rows whose source stated one of the codes (null never matches; no
inference from text), and `postedWithin` bounds `sort_at`, the same value `recent` orders by. Neither adds an index. `jobs_sort_at_idx (sort_at, id)` serves the two date orders and the posted
filter; `added` uses the primary key. `relevance` remains the default. Search sits behind these query functions;
vector/context search would be another implementation of the same query surface.

## Cost (10 daily users, ~300k stored jobs)

Workers Paid $5 + domain; D1 and R2 stay inside included allowances. No AI runs in the product (D15).

### D1 rows read and written: duplicate groups (estimates)

Open rows about 487k (production read-only count, Oct 26, 2026; the count moves with syncs). Estimates. The method was recorded with the removed assistant design and is not kept in this repo.

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

### Read cost of the hourly housekeeping (after migrations 0016 and 0017)

| Work                                                                    | Before                                                                                                  | After                                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Hourly regroup window (`jobs_updated_idx`, canonicals, crossed sources) | 3 hourly passes read each changed row (3-hour look-back)                                                | About 1.5 passes per changed row: the window starts at the last pass (`regroup_state`) less 30 minutes          |
| Hourly prune, `runs`                                                    | three full scans of `runs` per hour (the superseded ranking, the superseded select, the expired select) | index seeks on `runs_started_idx` and one scan of `runs_pack_idx` (about 2 packs per source, about 18k entries) |

The prune row is the one that grows: `runs` keeps every run for 30 days (about 9k a day, so about 270k rows at steady state),
which made the old hourly prune about 3 × 270k reads per hour (estimate; about 78k per hour at the 26k rows measured on
October 28, 2026). The regroup row is about half of the window-driven reads, and the same cursor bounds the crossed-source
band (sources that stopped listing), which was read three times too. The `sources` scan (8,894 boards) is still read each hour.
Estimates from the query plans and row counts; re-check with `EXPLAIN QUERY PLAN` on production after the migrations.

The hourly cursor is opaque (`i1:` plus JSON) and pages candidate rows, not distinct keys, in three phases: changed rows,
duplicates of changed canonicals, then crossed stale sources. Each phase continues with an equality/tie seek plus a newer
range (`updated_at = ? AND rowid > ?`, then `updated_at > ?`; for duplicates, `jobs_dup_of_idx` under each canonical; for
stale sources, `jobs_source_posting_idx` under the next source). A row-value `(updated_at, id) > (...)` cursor is not used:
SQLite filters it after reading every equal-timestamp row, which made small pages re-read the whole change window. Resuming
an interrupted incremental pass keeps the original pass time, so the next pass still covers writes that landed while it ran.
Full rebuilds keep plain dedupe-key cursors and never move the incremental checkpoint. No schema or index change is needed.

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
