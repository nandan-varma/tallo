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
| Workers | `tallo-api` (custom domain tallo-api.nandan.fyi, hourly cron at :17 UTC purge), `tallo-web` (tallo.nandan.fyi)                                     |
| Secrets | API: READ_TOKEN, INGEST_TOKEN. Web: READ_TOKEN, ACCESS_TOKEN. Local copies: `apps/runner/.env`, `~/.config/tallo/web-secrets.env` (both untracked) |
| Zone    | nandan.fyi (Cloudflare). `tallo-assets.nandan.fyi` not used yet                                                                                    |

## In flight

- Web workspace redesign: compact neutral shadcn UI, responsive job list and reading pane,
  Astro view transitions, Motion interactions, animated save feedback, browser-local saved roles,
  Radix select menus and mobile sheets, compact search/filters, and no promotional copy,
  persistent search filters, current-page salary sorting, and refreshed standalone role pages.
  Uses live API data only. `pnpm check` and the web build pass; browser inspection pending.

- #14 / PR #22: retention deployed with `cf`; migration 0003 applied via `cf d1 migrations`
  from Drizzle-generated SQL. Hourly cron retains two uploaded packs per source and 30 days
  of other run history. Retained pack rows remain as references. Independent review approved;
  `pnpm check` passes (135 tests). Production health and authenticated job search return 200.
  API version: `5c8b93ae-9493-4c90-9d6a-af5bba3fef7a`.

- **First full sweep (#1)** restarted with parallel platform collection on 2026-10-23.
  Main process PID 57310: Greenhouse/SmartRecruiters/Ashby/Lever, 32 board slots;
  Workday/Oracle Cloud run in a separate process with 8 board slots (distinct host sets).
  Main-process per-host concurrency is 8. Workday/Oracle uses 2 with a 250ms request gap
  after 3M returned 429s; its restarted PID is 58626. Upload concurrency is capped at 32 per
  process. Both append to
  `~/Library/Logs/tallo-sweep.log`. Fourteen interrupted runs across the two restarts were finalized partial via the API with
  closure disabled (six main-sweep runs and eight Workday/Oracle runs). Recent completed boards are reused; failed boards are retried.
  All six configured platforms are covered. Two existing upload-validation failures persist:
  `ashby:alan`, `greenhouse:bestversionmedia` (HTTP 400 on jobs upload); investigate before calling
  coverage complete. Failed/partial sources remain explicit, never counted as success.
  One-off resume/drain script: `~/.local/share/tallo/parallel-sweep.mjs` (absolute repo imports).
  Default platforms are the main four; use `--platforms=workday,oraclecloud --concurrency=8
  --per-host=2 --host-interval-ms=250` for
  the others. SIGTERM/SIGINT stops new board starts and drains active sources; do not launch a
  second process for overlapping platforms. Existing job keys and content hashes prevent duplicate
  catalog rows/blobs. Resume skips sources completed in the last 20h; review run issues for partial
  details before declaring completion. Workday unsplittable slices remain explicitly incomplete.
  Postflight PID 58786 (`~/.local/share/tallo/sweep-postflight.py`) waits for both collectors,
  retries boards with detail issues once with lower host limits, and writes unresolved latest
  runs to `~/Library/Logs/tallo-sweep-audit.json`. It does not silently treat partial data as success.
  After collection: resolve failed/partial boards, install launchd (`scripts/launchd/`), check storage,
  and record outcomes. Background work is active; no unattended code changes or deployments.

- **Merged but not deployed** (PRs #32 dead boards, #33 `/status` page + `GET /v1/runs`, #34 facets). Remote D1 still
  needs migrations 0004 `dead_boards` and 0005 `facet_counts` (in that order), then deploy API + web, then one
  `POST /v1/admin/facets/rebuild`. Held until the sweep finishes or the user says go. After deploy, run
  `EXPLAIN QUERY PLAN` on the facet rebuild to confirm it uses `jobs_feed_idx`.
- Follow-ups from reviews (no issue yet): runner treats any 404 inside `platform.list` as board-not-found
  (`apps/runner/src/sync.ts`); `/status` fetches all sources and renders `issue.url` without an https check; no HTTP
  test for `GET /v1/runs`; runbook should mention `/status`, `/v1/runs` and that `sources --dead` uses the ingest token.

## Merged this session

PR #32 dead boards (#3), #33 source status page (#11), #34 facets (#10).

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
