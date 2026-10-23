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
| D1      | `tallo` (001b036c-2e15-45c8-9284-edb9d374b849), migrations 0000–0002 applied remotely                                                              |
| R2      | `tallo-blobs`                                                                                                                                      |
| Workers | `tallo-api` (custom domain tallo-api.nandan.fyi, daily cron 05:17 UTC purge), `tallo-web` (tallo.nandan.fyi)                                       |
| Secrets | API: READ_TOKEN, INGEST_TOKEN. Web: READ_TOKEN, ACCESS_TOKEN. Local copies: `apps/runner/.env`, `~/.config/tallo/web-secrets.env` (both untracked) |
| Zone    | nandan.fyi (Cloudflare). `tallo-assets.nandan.fyi` not used yet                                                                                    |

## In flight

See labels on issues/PRs. At last update: PR #18 (shared host limiter) and #19 (job facts view) were in review
after fixes; #20 (Oracle Cloud) in review; first full production sweep (#1) waits on #18.

## Next (priority order)

1. #1 first full sweep + launchd schedule. 2. #13 classifier precision sampling at scale. 3. #3 dead boards,
   #14 raw pack pruning, #10 facets, #11 status page, more platforms (#6–#8), #9 source discovery (needs URL lists).

## Known gaps / notes

- Workday slices over 2,000 results that cannot be split report `complete: false` (closure skipped).
- Oracle finder caps at 10,000 results (see PR #20 notes).
- Pricing/limits were verified from vendor pages on 2026-10; re-verify before large changes.
