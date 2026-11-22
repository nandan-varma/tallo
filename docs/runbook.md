# Runbook

## Where things run

| Piece    | Where                                                                                     |
| -------- | ----------------------------------------------------------------------------------------- |
| Web      | Worker `tallo-web` at https://tallo.nandan.fyi (pages, public `/v1/*` proxy, `/llms.txt`) |
| API      | Worker `tallo-api` at https://tallo-api.nandan.fyi (ingest + admin; public reads refused) |
| Database | D1 `tallo` (001b036c-2e15-45c8-9284-edb9d374b849)                                         |
| Blobs    | R2 `tallo-blobs` (private): descriptions `jd/<sha256>`, raw packs `raw/<source>/<run>`    |
| Queue    | `tallo-collect` (dead letters: `tallo-collect-dlq`), Durable Object `HostGate`            |
| Mac      | launchd: boards that refuse Cloudflare's egress (`local-egress`) and the weekly D1 backup |

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
- Rate limit: `PUBLIC_LIMIT` in `apps/web/wrangler.jsonc`, 60 requests a minute per `cf-connecting-ip`. Counters are per
  Cloudflare location. A request with no address is refused.
- Edge cache: 200 answers for the lifetimes the API sets (search 5 min, postings and discovery 1 h); closed and hidden
  postings 60 s, unknown ids 1 h. Parameter errors are never cached.
- Log: one JSON line per public request (`event: "public_request"`): route, status, ms, cache, offset bucket and the origin's cost.
- Search cost: the ranked search cuts the best 10,000 index entries by bm25 before it joins rows (`FTS_WINDOW`), then keeps
  the best 2,000 that are visible. Date sorts page ids first, then read that page. A broad word ("manager", 160k matches)
  costs about 150 ms. If 503s return, look at `wrangler tail tallo-api` and the `rows_read` in the request log first.
- Confirm in the dashboard that the `*.workers.dev` URL is off for `tallo-api` (it has routes, so it should be).

## Collection

Boards are listed in `sources/*.json`. `tallo register` upserts them into D1 (`sources`); removing a board from the files
does not delete its row (see "Retire a board").

**Cloud (default).** Every five minutes the API Worker claims due boards (`sources.next_due_at`, 30-minute lease), puts
them on the `tallo-collect` queue, and a consumer collects, maps and ingests each one. A `HostGate` Durable Object spaces
requests per host. A board is due weekly (`hot.json` boards daily, dead boards every 30 days). After a failed or partial run
it backs off 1 h, 3 h, 6 h, then 24 h. Postings from a board that has not listed completely for 14 days stop showing in
search, so collection must keep running: check it weekly.

```sh
curl -H "authorization: Bearer $TALLO_INGEST_TOKEN" https://tallo-api.nandan.fyi/v1/admin/collect/status
```

It reports `dueNow`, `inFlight` and the last 24 hours. Healthy: `dueNow` near zero and falling after the first pass.
- Settings (`cloudflare.config.ts` and `wrangler.jsonc`, kept equal by a test): `COLLECT_ENABLED` (kill switch: `"0"` and deploy), `COLLECT_BATCH` (boards claimed per
  tick, 40), `COLLECT_SLICE_SUBREQUESTS`, `COLLECT_SLICE_MS`, consumer `max_concurrency` (8). A weekly pass of ~9k boards needs
  only about 4 boards a tick, so raise concurrency only for a catch-up and put it back.
- Dead letters: after 2 retries a message goes to `tallo-collect-dlq`. Nothing consumes it. The hourly cron reaps runs left
  `running` for 2 hours as partial; the board then backs off. Inspect with `wrangler queues` and the `runs` table.
- A board whose listing alone needs more than ~10,000 subrequests fails in the cloud; give it `"egress": "local"` and let the Mac do it.

**Mac (boards that refuse Cloudflare).** A board with `"egress": "local"` in its `params` (Workday tenants that redirect
the cloud, and the large single-host platforms: Amazon, Apple, Google, Meta, Netflix) is never claimed by the cloud. The
launchd job `fyi.nandan.tallo.local-egress` runs `tallo sync --local-egress` daily at 03:30:

```sh
apps/runner/launchd/local-egress.sh print|install|uninstall     # logs: ~/Library/Logs/tallo/local-egress.log
pnpm --filter @tallo/runner tallo sync -p greenhouse -n 20      # collect by hand
pnpm --filter @tallo/runner tallo verify greenhouse:stripe      # dry run: fields the mapper never reads
pnpm --filter @tallo/runner tallo register                      # after editing sources/*.json or egress flags
```

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

## Backup and restore

D1 Time Travel (30 days) is the primary backup. `scripts/backup-d1.sh run` also exports the real tables to
`~/Backups/tallo/` (the FTS index is derived: it is not exported). Weekly job: `apps/runner/launchd/backup.sh install`.

Restore: record the bookmark (`wrangler d1 time-travel info tallo --json`), then
`wrangler d1 time-travel restore tallo --bookmark <id>`. From an export: create a scratch D1, apply migrations, import the
SQL, then `INSERT INTO jobs_fts(jobs_fts) VALUES ('rebuild')`. Descriptions and raw packs live in R2 and are not in the export.
The catalog can also be rebuilt by a full collection pass.

## Troubleshooting

- **Search returns 503 "Database busy".** D1 shed load. Retry after the `Retry-After` header; if it persists check
  `wrangler tail`, `GET /v1/admin/collect/status` and whether a bulk run is writing.
- **Nothing new is showing.** `collect/status` (is `COLLECT_ENABLED` `"1"` and the `*/5` cron deployed?), then `tallo sources`.
- **A board keeps failing.** `GET /v1/runs?source=<platform:key>` (ingest token) for its issues; `tallo verify` reproduces it.
- **llms.txt is stale.** Deploy the web (`pnpm release`); it is prerendered at build time.
