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

Check health: `GET /v1/sources` (needs READ_TOKEN) shows `lastRunAt`, `lastCompleteRunAt`, `lastStatus`
per source. A source with no complete run for 7 days is stale.

## Troubleshooting

- _Run stuck "running"_: a run older than 2h no longer blocks the source; start another.
- _Source fails every run_: `tallo verify <id>`; 404 means the board moved or died (remove it from `sources/`).
- _Workday incomplete_: expected for slices that cannot be split; closure is skipped, jobs stay open.
- _Unexpected closures after a mapper change_: closures only come from complete listings; check `runs` for
  the source and whether its listing really shrank.
