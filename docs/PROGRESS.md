# Progress

_Last updated: 2026-10-23._ Stateless handoff: also read `gh issue list` and `gh pr list` (see `docs/workflow.md`).

## Done

- Core: contracts, http, catalog, platforms (Greenhouse, Lever, Ashby, SmartRecruiters, Workday), db (Drizzle,
  FTS5, ingest, queries, reclassify), API Worker, runner CLI, Astro web UI on shadcn components.
- Deployed: API https://tallo-api.nandan.fyi, web https://tallo.nandan.fyi (gated by access key).
- Read-side staleness policy (#2): jobs from sources with no listing for 14 days are hidden; `/v1/sources` has `freshness`.
- Classifier v2 (#13 partly): strong/weak title tiers with department vetoes; `tallo reclassify` upgrades flags
  from stored facts with no refetching. Re-run it after any rule change (bump `CLASSIFIER_VERSION`).
- Workflow: stateless GitHub-native process (`docs/workflow.md`), roles in `.claude/agents/`, review checklist.
- Sources seeded from the legacy registry: ~8.9k boards.

## Infra

| Thing   | Id / location                                                                                                                                      |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1      | `tallo` (001b036c-2e15-45c8-9284-edb9d374b849), migrations 0000–0003 applied remotely                                                              |
| R2      | `tallo-blobs`                                                                                                                                      |
| Workers | `tallo-api` (custom domain tallo-api.nandan.fyi, hourly cron at :17 UTC purge), `tallo-web` (tallo.nandan.fyi)                                       |
| Secrets | API: READ_TOKEN, INGEST_TOKEN. Web: READ_TOKEN, ACCESS_TOKEN. Local copies: `apps/runner/.env`, `~/.config/tallo/web-secrets.env` (both untracked) |
| Zone    | nandan.fyi (Cloudflare). `tallo-assets.nandan.fyi` not used yet                                                                                    |

## In flight

- #14 / PR #22: retention deployed with `cf`; migration 0003 applied via `cf d1 migrations`
  from Drizzle-generated SQL. Hourly cron retains two uploaded packs per source and 30 days
  of other run history. Retained pack rows remain as references. Independent review approved;
  `pnpm check` passes (135 tests). Production health and authenticated job search return 200.
  API version: `5c8b93ae-9493-4c90-9d6a-af5bba3fef7a`.

- **First full sweep (#1)** started 2026-10-23 16:23 PDT as a background process on this Mac
  (`~/Library/Logs/tallo-sweep.log`; order: ashby, lever, greenhouse, smartrecruiters; workday still to do).
  It is idempotent: if interrupted, rerun `tallo sync -p <platform> -c 6` (sources completed in the last 20h are
  skipped). Check progress with `grep -c '"msg":"synced"' ~/Library/Logs/tallo-sweep.log` and `GET /v1/sources`.
  After it finishes: install the launchd job (`scripts/launchd/`, see `docs/runbook.md`), check D1/R2 usage, record results here.

## Merged this session

PR #18 shared per-host limiter, #19 structured facts on the job page, #20 Oracle Cloud platform
(7 boards; the host-default guard refuses a wrong siteNumber; Tenet board dropped, see #21).

## Next (priority order)

1. Finish #1 (sweep, launchd, usage check). 2. #13 classifier precision at scale (re-sample after the sweep,
   rerun `tallo reclassify` after any rule change). 3. #3 dead boards, #14 raw pack pruning, #10 facets, #11 status
   page, #6-#8 more platforms, #9 source discovery (needs URL lists), #21 Tenet.

## Known gaps / notes

- Workday slices over 2,000 results that cannot be split report `complete: false` (closure skipped).
- Oracle finder caps at 10,000 results (see PR #20 notes).
- Pricing/limits were verified from vendor pages on 2026-10; re-verify before large changes.
