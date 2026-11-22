# Runbook

## Where things run

| Piece    | Where                                                                                     |
| -------- | ----------------------------------------------------------------------------------------- |
| Web      | Worker `tallo-web` at https://tallo.nandan.fyi (pages, public `/v1/*` proxy, `/llms.txt`) |
| API      | Worker `tallo-api` at https://tallo-api.nandan.fyi (ingest + admin; public reads refused) |
| Database | D1 `tallo` (001b036c-2e15-45c8-9284-edb9d374b849)                                         |
| Blobs    | R2 `tallo-blobs` (private): descriptions `jd/<sha256>`, raw packs `raw/<source>/<run>`    |
| Queue    | `tallo-collect` (dead letters: `tallo-collect-dlq`), Durable Object `HostGate`            |
| Mac      | all collection, by hand (`tallo sync`); no scheduled jobs                                 |

Secrets: API `INGEST_TOKEN` (Wrangler secret). The web has none. The runner reads `apps/runner/.env`
(`TALLO_API_URL`, `TALLO_INGEST_TOKEN`). Rotate with `openssl rand -hex 32`, `wrangler secret put`, update `.env`.

## Release

```sh
pnpm release      # check, apply D1 migrations, deploy API, deploy web, smoke test
```

`pnpm release` stops at the first failure. The last step, `scripts/smoke.ts`, fails when the live `/llms.txt` differs from
what this commit generates (the web Worker prerenders it, so a web deploy is what updates it), when a canary search
(`engineer`, `manager`, `analyst`, a company, a remote search, a date sort) is not a 200 in 8 seconds, or when the
API host answers public reads. A short run of 503 "Database busy" right after a deploy is retried; a lasting one fails the release.

Schema changes: edit `packages/db/src/schema.ts`, run `pnpm --filter @tallo/db exec drizzle-kit generate`, never edit
generated SQL (FTS is a custom migration). Migrations are forward-only and applied before the API is deployed, so write
them additive (new column or index) and make the old code tolerate them. `wrangler d1 migrations list tallo --remote` shows what is pending.

The API deploys with `cf deploy` from `apps/api/cloudflare.config.ts`. The Worker was created that way and `wrangler deploy`
refuses it ("last deployed using the declarative `exports` flow"). `apps/api/wrangler.jsonc` mirrors the config for local
development and `wrangler d1`; `apps/api/test/config.test.ts` fails if the two disagree. A leftover `apps/api/.cloudflare/`
makes `wrangler deploy` refuse, which is one more reason not to use it.

## Public API

`https://tallo.nandan.fyi/v1/*` is served by the web Worker, which forwards only `PUBLIC_PATHS` (`packages/contracts`) to the
API over a service binding. Everything else under `/v1` is 404 there. `tallo-api.nandan.fyi` refuses the public reads
(`READS_BLOCKED_HOST`, checked by `apps/api/test/config.test.ts`), so the proxy's rate limit and cache cannot be bypassed.
- Rate limits (`apps/web/wrangler.jsonc`, per `cf-connecting-ip`, counters per Cloudflare location, no address is refused):
  `PUBLIC_LIMIT` 60 requests a minute for everything, and `PUBLIC_HEAVY_LIMIT` 10 a minute for _fresh wide searches_
  (4+ titles or 3+ companies, `isHeavySearch` in `packages/contracts`). A wide search already in the edge cache does not
  spend the heavy budget, so repeating a question is free; only new wide ones are limited. A caller never has to give up
  a good answer: 429 says to use fewer, more specific titles.
- Edge cache: 200 answers for the lifetimes the API sets (search 15 min, postings and discovery 1 h). The cache key spells
  a question one way (lowercase words, single spaces, no repeated values, sorted), so `Manager` and `manager` share an entry; closed and hidden
  postings 60 s, unknown ids 1 h. Parameter errors are never cached.
- Log: one JSON line per public request (`event: "public_request"`): route, status, ms, cache, offset bucket and the origin's cost.
- Search cost: the ranked search cuts the best 10,000 index entries by bm25 before it joins rows (`FTS_WINDOW`), then keeps
  the best 2,000 that are visible. Date sorts read the newest 50,000 matches of the query (`DATE_SORT_WINDOW`; exact below that), then page ids, then read the page. A broad word ("manager", 160k matches)
  costs about 150 ms; eight broad titles with a date sort went from 5.4 s and 2.7M rows to about 0.1 s and 0.23M. If 503s return, look at `wrangler tail tallo-api` and the `rows_read` in the request log first.
- Confirm in the dashboard that the `*.workers.dev` URL is off for `tallo-api` (it has routes, so it should be).

## Collection

Boards are listed in `sources/*.json`. `tallo register` upserts them into D1 (`sources`); removing a board from the files
does not delete its row (see "Retire a board").

**Nothing is scheduled.** Collection runs on this Mac when asked, and nothing runs in the cloud. There are no launchd jobs
for scraping. Postings from a board that has not listed completely for 14 days stop showing in search, so a sweep is
needed at least every two weeks or the catalog empties.

```sh
pnpm --filter @tallo/runner tallo register                      # after editing sources/*.json
pnpm --filter @tallo/runner tallo sync                          # every board not completed in the last 20 h
pnpm --filter @tallo/runner tallo sync -p greenhouse -n 20      # one platform, at most 20 boards
pnpm --filter @tallo/runner tallo sync --local-egress           # only the boards the cloud cannot reach
pnpm --filter @tallo/runner tallo sync --stale-hours 144        # skip boards done within 6 days (a weekly sweep)
pnpm --filter @tallo/runner tallo verify greenhouse:stripe      # dry run: fields the mapper never reads
pnpm --filter @tallo/runner tallo abandon walmart:walmart       # release a stopped run's board now, not in 2 h
```

`sync` skips boards completed within `--stale-hours`, so a rerun is cheap and a stopped sweep resumes where it left off.
Boards tagged `"egress": "local"` (Amazon, Apple, Google, Meta, Netflix, four Workday tenants) are slow, single-host
platforms; they are only ever collected from the Mac.

**Full sweep: `tallo sweep`.** One process, one lane per platform group (greenhouse, lever, ashby, smartrecruiters,
workday, oracle-icims, small-ats, walmart, microsoft, apple, meta, big-sites), about 40 boards in flight in total, the Mac
kept awake (`caffeinate`). A multi-host lane keeps as many boards running as it has distinct pods to talk to (Workday 30,
Oracle and small ATS 6-8), because a board cannot exceed ~2 requests a second on its own: Workday pages 20 postings at a
time and its detail fetches wait on the pod, so more boards in parallel - not a higher perHost - is what fills a pod. Each lane has its own queue, host limiter and settings (concurrency, ceiling, perHost, gapMs,
paused, enabled), so a rate-limited host slows only its lane. The work list is computed once at start with the staleness
horizon fixed then (`--stale-hours`, default 20): never-synced boards first, then the oldest completed run; boards done
meanwhile are not repeated and boards that age out meanwhile are not added.

```sh
tallo sweep start --dry-run          # due boards per lane and the first few; collects nothing
tallo sweep start [lane ...]         # needs TALLO_API_URL / TALLO_INGEST_TOKEN; Ctrl-C or SIGTERM drains, twice kills
tallo sweep status [--json]          # table + last 15 events (or status.json); safe any time
tallo sweep set ashby concurrency=2 gapMs=500     # lane: concurrency ceiling perHost gapMs paused enabled
tallo sweep set global maxInFlight=20             # global: maxInFlight paused stop
tallo sweep set budget maxRowsWritten=8000000     # budget
tallo sweep pause [lane] / resume [lane]
tallo sweep stop                     # graceful drain: no new boards, in-flight boards finish, then exit
```

Files are in `~/Library/Logs/tallo/sweep/` (`--dir` or `TALLO_SWEEP_DIR`; `--control` for the control file alone):
`control.json` (re-read every 3 s; `set` validates and writes it, a hand edit works too, and an invalid value is ignored
with an event, never a crash), `status.json` (every 5 s: per lane state, due, done, permanent failures, stuck, deferred
with the next retry time, in-flight boards and how long each has run, requests, 429 count, concurrency and gap, boards/min,
requests/min, ETA, last 3 errors; globally in-flight, estimated D1 rows and R2 puts, budget used) and `events.jsonl`
(one decision per line, for example `ashby: 429 x3, concurrency 3 -> 1, gap 0 -> 8000 ms`, `workday: accenture deferred
6 min (409 busy)`, `budget 80% used`).

How it steers itself. **Rate (AIMD per lane):** a 429 halves the lane's concurrency (minimum 1) and raises its gap
(doubling; with Retry-After the lane also waits it out; a 429 without Retry-After, as Microsoft answers, jumps to 8 s and
doubles from there); after 5 clean boards concurrency rises by one up to `ceiling` and the gap halves, never back into
a gap that 429ed. **Deferral:** a board that fails with 429, 5xx, ingest 503, a network error or 409 (another run holds
it) is not retried inline: it waits with an exponential, jittered delay (about 1, 2, 4 min) while the lane works on other
boards, at most 4 attempts, then `stuck` with the reason. A 404 board, schema or validation error is `failed:permanent`
and not retried. A partial run never closes postings (the engine's rule). **Global guard:** an ingest 503 or a latency
spike halves the in-flight cap and pauses new starts briefly, then it recovers one board at a time. **Budget:** the
estimated D1 rows written (new about 20, changed 3, closed 5, plus 8 per run; first runs of a board count all as new) are
totalled; at `budget.maxRowsWritten` (default 6,000,000) every lane holds and an event asks the owner: raise the budget to
continue or `stop`. Unchanged postings are never written; the sweep adds no writes. Runs left open by a killed process are
reaped as partial by the hourly job and never close postings; to release such a board at once, use `tallo abandon
<source...>` (its runs go partial immediately, same path as the reaper; only for runs you know are dead).

**Probing the gap.** `gapMs` is where a lane starts, not a permanent cost: every 150 clean requests (and every 5 clean
boards) it halves, down to the
lane's `floorMs` (Workday and Oracle 100 ms, Walmart 250 ms, Apple and Meta 250 ms; lanes without a floor stop at their
configured gap). A gap that drew a 429 guards at 1.25x for half an hour, then that margin decays by half every 5 clean
boards, so a bad minute is not paid for all evening.

**Adaptive per-host limits.** `concurrency` stays the lane's ceiling; what a lane actually runs is `perHost` requests to
one host, one lane-wide AIMD: +1 after 150 clean requests up to the lane's `perHostCeiling`, halved on a 429 with a
hold-down, never back into a rate that drew a 429. Detail fetches to one host follow `perHost` (max 8). Workday and
Oracle are keyed per pod (tenant host), so one badly behaving pod does not slow the whole lane, and a board on a full or
held pod is not started. A pod's own gap is capped at 30 s (a lane's at 2 min) and walks back down on the clock as well as
on clean requests: after 2 quiet minutes it halves, so a Workday pod held at 8 s is not held there for the night. Learned values are written to `learned.json` (every minute and on exit; ignored after 7 days) so
a restart starts where the last run stopped. `tallo sweep status` shows `perHost n/ceiling` with the reason, `gap` with the floor it is probing to, per-pod rows,
and _where the time goes_ per lane: shares of source, limiter wait, cpu, ingest and retry waits, board wall p50/p90 and
requests per second per board (also in `--json`). A lane whose dominant cost stays put for five minutes says so in an
event, so a slow sweep can be read rather than guessed.

**Cloud (built, off).** The API Worker can collect a board itself: a queue consumer collects, maps and ingests it, and a
`HostGate` Durable Object spaces requests per host. `COLLECT_ENABLED` is `"0"`: the five-minute cron is still deployed, but while the switch is off the tick enqueues nothing.
To try a few boards once, name them (this works with the switch off):

```sh
curl -X POST -H "authorization: Bearer $TALLO_INGEST_TOKEN" -H 'content-type: application/json' \
  -d '{"sources":["greenhouse:stripe","lever:spotify"]}' https://tallo-api.nandan.fyi/v1/admin/collect
curl -H "authorization: Bearer $TALLO_INGEST_TOKEN" https://tallo-api.nandan.fyi/v1/admin/collect/status
```

To hand collection to the cloud later, set `COLLECT_ENABLED` to `"1"` in `cloudflare.config.ts` and `wrangler.jsonc`
(`config.test.ts` keeps them equal) and `pnpm release`. The tick claims `COLLECT_BATCH` (40) due boards, weekly per
board (`hot.json` daily), backing off 1 h, 3 h, 6 h, 24 h after a failure; consumer `max_concurrency` is 8. Set it back
to `"0"` to stop.

**Change a mapper.** Bump that platform's `version`; the next sync of each board re-fetches and re-maps its postings.

### Dead boards

Three first-request 404s in a row mark a board dead (checked every 30 days; a complete listing revives it).
`tallo sources --dead` lists them. Boards confirmed gone are removed from `sources/*.json`.

### Retire a board

Delete it from `sources/*.json`, then `tallo retire <platform:key>` (it removes the catalog rows, keeps run history and R2
objects). It refuses a board that is still configured.

### Retention

Hourly (`:17`): reap stuck runs, purge jobs closed 30+ days and orphaned description blobs, prune run history and raw
packs (two packs per source, 30 days of other runs, at most 1,000 blob deletes an hour), regroup duplicates, repair
boards stranded far in the future. Duplicates are one canonical row (`dup_of`); the hidden-source rule is 14 days.

## Status page

`https://tallo.nandan.fyi/status` shows the catalog's numbers (open jobs, postings collected, employers, boards,
platforms, freshness and collection health, a daily history, coverage by platform, employer and country, work mode,
share with stated pay). All counts are exact. The API's hourly cron (`refreshSiteStats`) stores them in one row of
`site_snapshot`: boards, freshness and health every hour (about 30k rows read), and the catalog count (every open job,
once, paged by id, about 1.5M rows) when the stored one is 20 hours old, which also adds the day's history point.
That is roughly 50M rows read a month, far inside the plan's 25B. A page view never reads the catalog: the web Worker
asks the internal route `GET /v1/site-stats` (one row; refused on the API's own host like the other public reads, not
in `PUBLIC_PATHS`, `llms.txt` or OpenAPI; 503 until the first cron run) and keeps the answer at the edge for five
minutes. A failed refresh leaves the last row in place (logged as `job: "site-stats"`). To refresh by hand, run the
hourly cron from the dashboard. Change the numbers in `packages/db/src/site-stats.ts`.

## Weekly check (five minutes)

1. Has a sweep run in the last two weeks? `tallo sources` lists boards by last listing; run `tallo sync` if many are old.
2. `wrangler d1 info tallo --json`: `rows_written_24h`. The Workers Paid plan includes 50M writes a month (about 1.6M a
   day); steady-state weekly collection writes roughly 0.2M to 0.8M a day. A sustained day above 1.6M means a bulk
   re-fetch (a platform `version` bump) or a stuck retry loop: look at `runs` for repeated partials.
3. `tallo sources --dead`: boards confirmed gone (a 404 on the board's own API) are removed from `sources/*.json` and
   retired with `tallo retire <platform:key>`.

## Backup and restore

D1 Time Travel (30 days) is the primary backup. `scripts/backup-d1.sh run` also exports the real tables to
`~/Backups/tallo/` (the FTS index is derived: it is not exported). An optional weekly launchd installer exists (`apps/runner/launchd/backup.sh`); none is installed.

Restore: record the bookmark (`wrangler d1 time-travel info tallo --json`), then
`wrangler d1 time-travel restore tallo --bookmark <id>`. From an export: create a scratch D1, apply migrations, import the
SQL, then `INSERT INTO jobs_fts(jobs_fts) VALUES ('rebuild')`. Descriptions and raw packs live in R2 and are not in the export.
The catalog can also be rebuilt by a full collection pass.

## Troubleshooting

- **Search returns 503 "Database busy".** D1 shed load. Retry after the `Retry-After` header; if it persists check
  `wrangler tail`, `GET /v1/admin/collect/status` and whether a bulk run is writing.
- **Nothing new is showing.** Run `tallo sync` (nothing is scheduled), then `tallo sources`.
- **A board keeps failing.** `GET /v1/runs?source=<platform:key>` (ingest token) for its issues; `tallo verify` reproduces it.
- **llms.txt is stale.** Deploy the web (`pnpm release`); it is prerendered at build time.
