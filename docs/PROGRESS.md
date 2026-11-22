# Status

_Updated 2026-11-22 (end of the collection-rework session)._ The product is complete and deployed. What remains is
running it: scraping is manual, nothing is scheduled, and the cloud collector is built but switched off. History is in
`git log`; design reasons are in `docs/decisions.md`; how to operate is `docs/runbook.md`; the audit that produced this
session's app fixes is in `docs/plan-polish.md`.

## Cleanup validation (2026-11-22)

Issues #225–#231 track the cleanup. Cloud support is retained. Mac and cloud baseline on `lever:15five`: four postings, complete, no changes or closures. Production checks found zero null dedupe keys and 15,634 rows containing inferred values: retire dedupe backfill, retain inferred filtering. The API now derives cf deployment settings from canonical `apps/api/wrangler.json`; scheduled collection remains off. Historical measurements and session notes below are retained as history.

## What exists

- **Public API** (`GET` only, no key): `/v1/search`, `/v1/jobs/:id`, `/v1/jobs/:id/description`, `/v1/companies`,
  `/v1/titles`, `/v1/openapi.json`. Served by the web Worker, which proxies to the API Worker (rate limits, edge cache).
- **`/llms.txt`**: generated from the API's zod schemas (`packages/contracts/src/llms.ts`); `pnpm release` fails if the
  live text differs from the commit's.
- **Web**: search on the homepage, and `/status` (exact catalog numbers, freshness, collection health and a daily history;
  stored hourly by the API cron in `site_snapshot`, catalog recount about daily; internal route `GET /v1/site-stats`
  is a one-row read, edge-cached five minutes).
- **Catalog**: 9,528 boards on 26 platforms (`sources/*.json`), **727,726** open postings at the recount of 2026-11-22
  07:08 UTC (2,458,115 collected all time, 9,303 employers; 9,509 of the boards listed in the last 7 days, 33 not
  listing cleanly, 66 retired). Facts are what sources state; no heuristics in the database (D6).
- **Collection**: local and manual (`tallo sync`, run when asked); no Mac jobs, nothing in the cloud. The cloud collector
  (queue, `HostGate`, five-minute cron) is built and toggled off by `COLLECT_ENABLED` `"0"`; named boards can be tried
  on it once. A sweep is needed within 14 days or postings hide. `tallo sweep` steers itself: AIMD per-host limits keyed
  per pod for Workday and Oracle, pod-aware scheduling that spreads boards over pods, learned limits in `learned.json`,
  a start gap that probes down to a per-lane floor and recovers on the clock after a 429, per-lane timing shares (with
  the source split into paging and posting fetches) and bottleneck events, and `tallo abandon <source...>` releases a
  stopped run's board at once instead of waiting out the 2 h lease (nothing closes).
- **Housekeeping**: hourly reap, purge, prune, regroup (API cron). D1 backup: `scripts/backup-d1.sh run`.

## Platforms

Applicant-tracking: greenhouse, lever, ashby, smartrecruiters, workable, recruitee, personio, teamtailor, bamboohr,
jobvite, icims, oraclecloud, workday, rippling, gem, pinpoint, breezy. Own sites: amazon, apple, google, meta, netflix,
microsoft, ibm, goldman, walmart (the single-host ones are tagged `"egress": "local"`). Details: `docs/platforms.md`.

## This session (2026-11-22): collection, measured

Collection was reworked against measurements rather than guesses, all with two facts in hand: a board's wall time is
ingest round trips (7 API calls, ~1.8 s on a Greenhouse board: 1 source request, the rest Diffs and uploads), and a
source's rate is set by its host's gap and `perHost`, never by lane concurrency.

| lane          | before                                    | after                                                                           | why                                                                                                                          |
| ------------- | ----------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Walmart       | 86 req/min, every run stuck               | 240 → ~340 req/min, **first complete run** (15,556 listed, 823 gone ids, 535 s) | ceiling 3 → 8; floor 700 → 200 ms; `PostingGone` for the ~7 % of sitemap ids that answer `307 → /job-not-found` (issue #182) |
| Workday       | 8 req/s, 70 % limiter wait, 2 h per giant | 26 req/s peak, 12–13 req/s steady, 0 × 429                                      | 30 boards over pods, spread to idle pods, perHost 10, gap floor 250 ms, pod-local 429                                        |
| Oracle        | 1 req/min behind a 120 s gap              | 0 × 429 at 8 boards, gap 250 ms                                                 | probing to 100 ms drew 217–476 429s from `fa.us2`; the floor is the rate it starts at                                        |
| catalog lanes | 5 Greenhouse boards in flight             | 1,494 Greenhouse boards in ~6 min                                               | a board is ~7 ingest calls; `perHost` (not concurrency) is what the host sees                                                |

Also this session: three ATS **sandbox tenants** left the catalog (`greenhouse:example`, `greenhouse:testing`,
`ashby:ashby-embed-demo-org` — 37 jobs, 6 raw packs, 21 orphaned descriptions for the hourly purge; a test now refuses
that class of board). The web app got the API's other parameters (sort, country, recency, company-only search,
`capped`/`expanded` notices, formatted pay and relative dates) and a truthful `/status` that links from a footer.

## Settled in the build

- Search cost: the candidate cut runs on the FTS index first (`FTS_WINDOW`), date sorts read the newest 50,000 matches,
  the edge cache key ignores case and spacing and holds searches 15 minutes, and fresh wide searches (4+ titles or 3+
  companies) have a 10 a minute budget. Cloudflare's rate-limit counters are approximate, so it throttles after about 20.
- One release command (`pnpm release`) and a smoke test. The API Worker derives `cf deploy` settings from the canonical
  Wrangler configuration.
- Scraper audits: Greenhouse needs one request per board; Oracle list requests roughly halved; Workday slicing cheaper on
  large tenants (Citi 791 to 692 requests, identical postings); Rippling pages of 500.

## Deployments

- API Worker: deployed 2026-11-22 with the `gone` issue code (verified: `finalize` with `gone` answers 404 unknown run,
  not 400). D1 migrations: none pending.
- Web Worker: deployed 2026-11-22 after the search and status changes, with `pnpm release` (check, migrate, API, web,
  smoke).
- `/status` snapshot refreshed at 07:08 UTC with a full catalog recount; the hourly cron keeps the live part fresh.

## Open (GitHub issues)

- #183 map unread Goldman and Walmart fields. (#182 Walmart expired ids is fixed: they are `gone` now.)
- #185 Radancy TalentBrew (AT&T, Walgreens, Kroger). #186 listing surface for Kroger, Starbucks, UPS, Lockheed,
  Albertsons, Dell, Best Buy, FedEx, Publix (Tesla, McDonald's and Dell answer 403 to plain requests; see
  `docs/research/retailers.md`).
- #188 Breezy: cheaper description path. #189 more Rippling, Gem, Pinpoint and Breezy boards.
- #142 confirm Google's `postedAt` slot. #137 resume Apple's sync. #9 source discovery.

## Where a sweep stood at the end of the session

Stopped by hand; nothing was left running. A board that is not collected today is only staler tomorrow, and the 14-day
horizon is far off.
- **Due next**: Workday **403 boards** (`--stale-hours 20`; the 144 h set's 60 are done except 4 stuck on Workday 500s)
  and Oracle **38 boards**. Then the full sweep at 144 h, which is what yesterday's session was doing.
- **Stuck, needs a fresh lane, not new settings**: Oracle 8–9 boards (476 × 429 from `fa.us2`, which also answered 429
  to a 250 ms gap; let the pod cool, then rerun), plus 3 permanent 404s (Greenhouse), 1 ashby stuck/1 permanent,
  1 meta stuck, 1 Microsoft board that 429s every run and may stick.
- **No settings are pending**: every lane already runs the values this session measured out. `learned.json` in each
  sweep dir carries the limits each lane ended on; a restart from a new dir starts from the configured values.

## Known limits (accepted)

- Search lists at most 300 results per query (`SEARCH_RESULT_CAP`); refine the query rather than page deeper.
- `countryCode`, `postedAt`, pay and work mode are null where the source states nothing; they are never inferred.
- Oracle boards larger than 10,000 postings (Dollar General) are never reported complete, so they never close
  postings. Two Oracle boards (eeho, edel) end partial with "Short page". Partial runs never close postings.
- Uber's careers API path is disallowed by its robots.txt, HirePro needs a captcha, and Eightfold tenants answer 403:
  none of them is scraped.
- A first Walmart sync is about 15,300 requests, and about 7% of its sitemap ids are expired: those answer a
  job-not-found page and are dropped from the listing as `gone` (they close by absence), so the board can finish.
  Microsoft is about 2,600 requests.
- About 42 Rippling, Gem, Pinpoint and Breezy boards were added without a `tallo verify` run; a failing one shows as
  a partial or dead board.
