# Status

_Updated 2026-11-21._ The project is feature-complete. What remains is running it: collection is automatic, and the
only regular chores are the ones in `docs/runbook.md`. History is in `git log`; design reasons are in `docs/decisions.md`.

## What exists

- **Public API** (`GET` only, no key): `/v1/search`, `/v1/jobs/:id`, `/v1/jobs/:id/description`, `/v1/companies`,
  `/v1/titles`, `/v1/openapi.json`. Served by the web Worker, which proxies to the API Worker (rate limit, edge cache).
- **`/llms.txt`**: generated from the API's zod schemas (`packages/contracts/src/llms.ts`), so it cannot describe a
  field the API does not return. `pnpm release` fails if the live text differs from the commit's.
- **Web**: home and `/search`, plain HTML forms, results link to the employer's application.
- **Catalog**: ~9k boards on 19 platforms (`sources/*.json`), ~700k open postings. Facts are what sources state;
  no heuristics in the database (D6).
- **Collection**: local for now. A weekly launchd job (`full-sync.sh`) collects every board; a daily one collects the
  `"egress": "local"` boards (Amazon, Apple, Google, Meta, Netflix, four Workday tenants). The cloud collector (queue +
  `HostGate`) is built and switched off (`COLLECT_ENABLED` `"0"`); named boards can be tried on it.
- **Housekeeping**: hourly reap, purge, prune, regroup. Weekly D1 export is a launchd job on the Mac.

## Settled in the final pass

- Search cost: the ranked candidate cut runs on the FTS index first (`FTS_WINDOW`), so a broad word costs ~150 ms
  instead of ~5 s, and date sorts page ids before reading rows. This was the cause of the "Database busy" 503s.
- Cost and UX balance: date sorts read the newest 50,000 matches (exact below that); the edge cache key ignores case and
  spacing and holds searches 15 minutes; fresh wide searches (4+ titles, 3+ companies) have a 10 a minute budget that
  cached repeats do not spend. Cloudflare's rate-limit counters are approximate, so it throttles after about 20, not
  exactly 10. A date-sorted query matching over 50,000 postings ranks only its newest 50,000.
- One release command (`pnpm release`) and one smoke test. The API Worker has two config files (`cf deploy` and
  `wrangler`), kept equal by a test.
- Removed: cloud/Mac duplicate launchd jobs, benches, the multi-agent workflow files, unused dependencies, test-only
  helpers in the query module, and the stale issue backlog.

## Known limits (accepted)

- Search lists at most 300 results per query (`SEARCH_RESULT_CAP`); refine the query rather than page deeper.
- `countryCode`, `postedAt`, pay and work mode are null where the source states nothing; they are never inferred.
- Apple is only partly ingested (a resumable Mac sync: `tallo sync -p apple`). HirePro has no usable public listing.
- Retired in the final pass: four boards that returned 404 (Ashby cedar, Greenhouse goodjobgames, kunai, tula) and the
  NXP Workday tenant (422 on every host). Two Oracle boards (eeho, edel) still end partial with "Short page"; a partial
  run never closes postings, so they only lose freshness.
- Workday and Oracle boards with very large listings may finish partial; partial runs never close postings.
