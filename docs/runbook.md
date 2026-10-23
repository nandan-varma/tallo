# Runbook

## Environments

| Piece    | Where                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------- |
| Web      | Worker `tallo-web` → https://tallo.nandan.fyi                                                       |
| API      | Worker `tallo-api` → https://tallo-api.nandan.fyi (runner ingests here; web uses a service binding) |
| Database | D1 `tallo`                                                                                          |
| Blobs    | R2 bucket `tallo-blobs` (private)                                                                   |
| Runner   | this Mac, `apps/runner`, daily via launchd                                                          |

Resource ids and URLs are recorded in `docs/PROGRESS.md`. Secrets are never committed.

## Secrets

- API: `READ_TOKEN`, `INGEST_TOKEN` (Wrangler secrets on `tallo-api`).
- Web: `READ_TOKEN` (same value as the API's), `ACCESS_TOKEN` (the key you open the site with).
- Runner: `apps/runner/.env` with `TALLO_API_URL` and `TALLO_INGEST_TOKEN`.

Rotate: generate a new value (`openssl rand -hex 32`), `wrangler secret put`, update `.env`.

## Deploy

```sh
pnpm check
pnpm --filter @tallo/api exec wrangler d1 migrations apply tallo --remote   # schema changes
pnpm --filter @tallo/api deploy
pnpm --filter @tallo/web deploy
```

Migrations are forward-only. D1 Time Travel is the backup for the catalog; the catalog is also rebuildable
from raw packs plus a full sweep.

## Daily collection (launchd)

`~/Library/LaunchAgents/fyi.nandan.tallo.sync.plist` runs `pnpm --filter @tallo/runner tallo sync` at 06:30
(see `scripts/launchd/fyi.nandan.tallo.sync.plist` for the template). The Mac may sleep: the job runs on wake.
`sync` skips sources completed within `--stale-hours` (default 20), so reruns are cheap and idempotent.

### Politeness (per-host limits)

Many sources share a few hosts (thousands of Greenhouse/Ashby boards). One limiter per process caps every
source's requests to a host together, however many sources run in parallel (`--concurrency`).

| Flag                 | Env                      | Default | Meaning                                            |
| -------------------- | ------------------------ | ------- | -------------------------------------------------- |
| `--per-host <n>`     | `TALLO_PER_HOST`         | `8`     | Max in-flight requests to one host, across sources |
| `--host-interval-ms` | `TALLO_HOST_INTERVAL_MS` | `0`     | Min gap in ms between new request starts to a host |

Flags win over env. Invalid values (non-numeric, below the minimum) fail before any network call. Raise
`--host-interval-ms` (e.g. `250`) if a host starts returning 429s; `--per-host 1` with a gap is the most
conservative setting. Retries after a 429/5xx keep their per-host slot but do not wait for the gap.
`verify` uses its own limit of 4 and is not shared.

Check health: `GET /v1/sources` (needs READ_TOKEN) shows `lastRunAt`, `lastCompleteRunAt`, `lastStatus`
per source. A source with no complete run for 7 days is stale.

## Troubleshooting

- _Run stuck "running"_: a run older than 2h no longer blocks the source; start another.
- _Source fails every run_: `tallo verify <id>`; 404 means the board moved or died (remove it from `sources/`).
- _Workday incomplete_: expected for slices that cannot be split; closure is skipped, jobs stay open.
- _Unexpected closures after a mapper change_: closures only come from complete listings; check `runs` for
  the source and whether its listing really shrank.

## Raw pack and run retention

The hourly API cron keeps the newest two finalized raw packs per source (complete or partial),
ordered by run start time and id. It deletes older packs before clearing their run references,
so storage failures can be retried safely. Unfinalized packs are removed after 30 days.
Run rows older than 30 days are deleted once their pack is removed; the two retained pack
references are exempt so later sweeps can still prune them. Source health and jobs are unchanged.
Each invocation removes at most 1,000 packs and 1,000 expired run rows; a backlog drains over
subsequent hourly invocations.

The hourly schedule permits up to 24,000 pack deletions and run deletions per day, exceeding
the configured roughly 9,000-board daily sweep. Raw uploads record their key before writing R2
so interrupted uploads can be removed after 30 days.

Apply migration `0003` before deploying: `runs.raw_uploaded` distinguishes successful packs
from upload intent, so failed uploads cannot displace retained packs. Existing tracked packs
are treated as uploaded. Packs orphaned before upload tracking was introduced are not reclaimed.
