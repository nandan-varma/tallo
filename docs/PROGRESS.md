# Status

_Updated 2026-11-21 (end of the build session)._ The product is complete and deployed. What remains is running it:
scraping is manual, nothing is scheduled, and the cloud collector is built but switched off. History is in `git log`;
design reasons are in `docs/decisions.md`; how to operate is `docs/runbook.md`.

## What exists

- **Public API** (`GET` only, no key): `/v1/search`, `/v1/jobs/:id`, `/v1/jobs/:id/description`, `/v1/companies`,
  `/v1/titles`, `/v1/openapi.json`. Served by the web Worker, which proxies to the API Worker (rate limits, edge cache).
- **`/llms.txt`**: generated from the API's zod schemas (`packages/contracts/src/llms.ts`); `pnpm release` fails if the
  live text differs from the commit's.
- **Web**: home, `/search`, and `/status` (catalog numbers, freshness and coverage; cached 12 hours; sampled figures
  are labelled approximate; internal route `GET /v1/site-stats`, about 250k D1 rows per snapshot).
- **Catalog**: 9,534 boards on 26 platforms (`sources/*.json`), roughly 700k open postings. Facts are what sources
  state; no heuristics in the database (D6).
- **Collection**: local and manual (`tallo sync`, run when asked); no Mac jobs, nothing in the cloud. The cloud collector
  (queue, `HostGate`, five-minute cron) is built and toggled off by `COLLECT_ENABLED` `"0"`; named boards can be tried
  on it once. A sweep is needed within 14 days or postings hide.
- **Housekeeping**: hourly reap, purge, prune, regroup (API cron). D1 backup: `scripts/backup-d1.sh run`.

## Platforms

Applicant-tracking: greenhouse, lever, ashby, smartrecruiters, workable, recruitee, personio, teamtailor, bamboohr,
jobvite, icims, oraclecloud, workday, rippling, gem, pinpoint, breezy. Own sites: amazon, apple, google, meta, netflix,
microsoft, ibm, goldman, walmart (the single-host ones are tagged `"egress": "local"`). Details: `docs/platforms.md`.

## Settled in the build

- Search cost: the candidate cut runs on the FTS index first (`FTS_WINDOW`), date sorts read the newest 50,000 matches,
  the edge cache key ignores case and spacing and holds searches 15 minutes, and fresh wide searches (4+ titles or 3+
  companies) have a 10 a minute budget. Cloudflare's rate-limit counters are approximate, so it throttles after about 20.
- One release command (`pnpm release`) and a smoke test. The API Worker has two config files (`cf deploy` and
  `wrangler`), kept equal by a test.
- Scraper audits: Greenhouse needs one request per board; Oracle list requests roughly halved; Workday slicing cheaper on
  large tenants (Citi 791 to 692 requests, identical postings); Rippling pages of 500.

## Open (GitHub issues)

- #182 Walmart: skip expired ids without failing the run. #183 map unread Goldman and Walmart fields.
- #185 Radancy TalentBrew (AT&T, Walgreens, Kroger). #186 listing surface for Kroger, Starbucks, UPS, Lockheed,
  Albertsons, Dell, Best Buy, FedEx, Publix (Tesla, McDonald's and Dell answer 403 to plain requests; see
  `docs/research/retailers.md`).
- #188 Breezy: cheaper description path. #189 more Rippling, Gem, Pinpoint and Breezy boards.
- #142 confirm Google's `postedAt` slot. #137 resume Apple's sync. #9 source discovery.

## Known limits (accepted)

- Search lists at most 300 results per query (`SEARCH_RESULT_CAP`); refine the query rather than page deeper.
- `countryCode`, `postedAt`, pay and work mode are null where the source states nothing; they are never inferred.
- Oracle boards larger than 10,000 postings (Dollar General) are never reported complete, so they never close
  postings. Two Oracle boards (eeho, edel) end partial with "Short page". Partial runs never close postings.
- Uber's careers API path is disallowed by its robots.txt, HirePro needs a captcha, and Eightfold tenants answer 403:
  none of them is scraped.
- A first Walmart sync is about 15,300 requests at one every 700 ms; Microsoft about 2,600.
- About 42 Rippling, Gem, Pinpoint and Breezy boards were added without a `tallo verify` run; a failing one shows as
  a partial or dead board.
