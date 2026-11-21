# Progress

_Last updated: 2026-11-21; current handoff below. Historical notes: 2026-10-28 (cloud collection on branch `worktree-agent-a62304caf8f590baa-collect`: queue, HostGate, schedule in D1; Mac runner keeps manual sync). Earlier: 2026-10-26 (write-cost quick wins; ranked search; no heuristics in the database; tracker, saved searches, fit, cover letter, dark mode)._ Stateless handoff: also read `gh issue list` and `gh pr list` (see `docs/workflow.md`).

## Session 2026-11-21: group 3 field audit (workable place fallback)

- The read-only audit of personio, recruitee, teamtailor, workable and bamboohr found one real gap: Workable's
  mapper read only `locations[]`, so a posting whose per-place entries are absent or blank lost the job-level
  `city`/`state`/`country` the widget states. `workable.map` now uses those job-level fields only when every
  `locations[]` entry has no text. `version` bumped 1 → 2 so retained postings re-map.
- Regression covers both shapes (missing `locations`, one all-blank entry) in `platforms.test.ts`.
- Deliberately unchanged: Workable `created_at`, Recruitee `state_code`, BambooHR `locationType`/`jobCategoryId`/
  `postalCode` and Teamtailor `address`/`zip` have no typed home (or, for `locationType`, unverified semantics),
  so they stay in raw/extras; mapping them would not improve search and would force a platform-wide re-fetch.
- `pnpm check`: 670 tests pass. Full audit at /tmp/tallo-fields-group3.md; handoff at
  /tmp/tallo-fields-group3-handoff.md. No production access, no deploy.

## Core DB audit patch (branch `fix/db-audit`, review pending)

- #99: a non-authoritative empty listing no longer stores a cached validator; `finalize` writes it only when closure was
  applied, details were complete and no absence is pending. Regression added in `validator.test.ts`.
- #114: the hourly regroup now pages opaque `i1:` cursors over changed rows, changed canonicals and crossed stale sources.
  Each continuation uses indexed equality/tie and newer-range seeks instead of re-reading the change window per page.
  A resumed pass keeps its original pass time; full dedupe-key rebuilds never advance the incremental checkpoint.
  The admin `after` cap grew to 8192 for the opaque cursor. No migration or index change.
- Local evidence: DB suite 145 tests and the added cursor/API tests pass; the optional
  `node packages/db/bench/regroup-scan.ts` shows the old row-value cursor at about 99k SQLite VM steps for a 10k-row
  equal-timestamp backlog versus tens of steps for the captured equality/tie query. Main owns review, merge and deploy.

## Session 2026-11-20: production outcome

- Recovery changes merged: #110 (`bd3837e`, adapters and restored tests), #115 (`379dfd8`, D1 retry
  response and research), #118 (`cf67e0d`, structured-country mapping). All PR checks passed.
  Latest full local check: 547 tests, no skips. Astro production build and API builds passed.
- Migrations 0020 and 0021 are applied remotely. Latest API deploy: `c0868408-7933-45bf-94bf-f8c10cedc933`;
  web deploy: `5519de0e-0409-4aa5-bba1-4c95918dc8e0`. Public search and llms.txt return 200;
  direct API reads and public admin paths return 404. API secrets: INGEST_TOKEN only. Web secrets: none.
- The authorized one-off Mac sweep excludes Workday and Oracle Cloud. No recurring job was installed.
  All 25 iCIMS and all 26 Jobvite boards completed successfully, verified from production source state.
  Liberty Mutual's original 400 was fixed and all 227 postings ingested successfully on retry.
- Final production source-state audit: **7,962 eligible boards attempted across 11 platforms;
  7,958 listings completed, 4 boards returned 404** (`ashby:cedar`, `greenhouse:goodjobgames`,
  `greenhouse:kunai`, `greenhouse:tula`; #119). Existing dead/empty-board back-offs were respected.
  Two individual untitled Ashby postings were skipped on otherwise complete boards (#120).
  Latest-run issue audit shows no remaining running runs from this session.
- Dominos completed all 25,136 listings (4,989 new postings, 5,241 source requests); SpaceX completed
  2,821 listings. The final CLI run had 2,397 sources and 4 incomplete listings, all the 404s above.
  Source-state totals above deduplicate the interrupted/retried CLI runs.
- Early attempts were interrupted after D1 overload. Their running runs were finalized through ingest as
  partial with closureApplied=false. The corrected API returns 503/Retry-After 10 for overload; the
  ingest client is tested to wait the full window. Source collection stayed on this Mac.
- Cloud collection remains OFF (live admin status verified false); hourly housekeeping stays enabled.
  Keep the expensive platforms excluded until the research follow-ups are evaluated.
- Deferred work: #111 raw-pack re-mapping, #112 Oracle listing parameters, #113 Workday early splitting,
  #114 D1 workload investigation, #116 complete iCIMS raw HTML, #119 retired source configs,
  #120 untitled source postings.
  HirePro remains blocked (#81, captcha-gated listing token). The obsolete classifier task (#13) was
  closed because the current architecture explicitly excludes classifier heuristics.

## Session 2026-11-20: finish interrupted integration

- Restored the worker-pool integration test (#108). Its failure was a removed `/v1/jobs` route in the test,
  before the pooled run even started. It now compares `/v1/search` results and always closes its workers.
- Restored all 13 Teamtailor/BambooHR tests (#105) in separate test files.
- Integrated Jobvite (#87, supersedes PR #109) and iCIMS (#80) from their original commits, preserving
  existing platform registrations and ETag tests. Added strict Jobvite XML validation and Jibe count validation.
- `pnpm check`: 539 tests pass, no skips. Live sample verification: Jobvite/Forescout and
  iCIMS/Pattern Energy, two postings each. Original adapter handoffs record all seeded-board checks.
- PR #110 merged at `bd3837e`. Production migrations 0020 and 0021 applied; API version
  `4b291aef-0426-429e-951f-af1130d075ae`, web `5519de0e-0409-4aa5-bba1-4c95918dc8e0`.
  Public search and llms.txt return 200; direct API reads and public admin routes return 404.
- The first Mac sweep hit D1 overload (7429/429 on a direct diagnostic query; ingest surfaced 500s).
  Stopped both attempts; finalized their running runs as partial through the API, never applying closure.
  A ten-board Greenhouse diagnostic batch completed cleanly. #114 tracks the load investigation.
- Added overload-specific HTTP 503 with Retry-After 10, including wrapped Drizzle errors. Client tests
  prove ingest waits the full window before retrying. Other errors retain 500 and no query text is exposed.
- Live sweep found Liberty Mutual's `addressCountry` can be an unresolved source template, not a
  country code. iCIMS v2 passes it as a structured country value to the existing ISO normalization;
  unknown codes stay unset. Regression checks cover the real template and a full country name.
  `pnpm check`: 547 tests. Targeted Liberty Mutual retry runs the corrected mapper; other in-flight
  valid v1 boards finish normally. The next sync detects v2 and re-fetches old v1 postings by design.
- Original scope excludes Workday and Oracle Cloud from this one-off sweep. Keep them excluded until
  follow-up optimizations are evaluated. Cloud collection remains OFF; hourly housekeeping stays.
- Research #88 is written up in docs/research/hog-fetching.md and hog-fetching-oracle.md.
  Follow-ups: #111 re-map raw packs, #112 Oracle listing parameters, #113 Workday early splitting.
  Large Workday baseline comparisons did not complete; no measured savings are claimed for them.
- HirePro remains blocked (#81: no usable unauthenticated listing surface). Non-P1 follow-ups remain in issues.

## Session 2026-11-21: cloud collection is OFF

**Cloud collection is stopped (issue #77).** `COLLECT_ENABLED` is `"0"` and the `*/5` collect cron is removed from
`apps/api/wrangler.jsonc` and `cloudflare.config.ts`. The hourly housekeeping cron (`17 * * * *`: reap, purge, prune,
regroup) stays. The Mac runner is the only collector (`pnpm --filter @tallo/runner tallo sync`). The queue consumer, the
`tallo-collect` queue and the `HostGate` Durable Object stay deployed and idle. Turn cloud collection back on: runbook,
"Cloud collection (queue)", step 6 (set `COLLECT_ENABLED` to `"1"` and restore the `*/5 * * * *` trigger in both files).
The "Session 2026-10-28" notes below describe the previous, cloud-collecting state.

## Session 2026-11-11: public API for the user's own AI (issue #75, PR open, not merged)

- Public reads: `GET /v1/search`, `GET /v1/jobs/:id`, `GET /v1/jobs/:id/description`. No token, GET only. The web Worker
  forwards exactly these (`PUBLIC_PATHS`), with a 60/minute per-address binding (`PUBLIC_LIMIT`, unverified in production),
  a 2 KB URL cap and an edge cache. `/llms.txt` is generated from the API's zod schemas and tested against the routes.
- Removed: `GET /v1/jobs` (free text) and `POST /v1/jobs/search`. `READ_TOKEN` retired (API and web); the sources and runs
  reads now need `INGEST_TOKEN`. Migrations: none. The `searchJobs` db helper stays for the db tests (no route uses it).
- `tallo-api.nandan.fyi` refuses the public reads (`READS_BLOCKED_HOST`, kept in step in `apps/api/wrangler.jsonc` and
  `cloudflare.config.ts`); ingest and admin stay on it. Open: confirm `workers.dev` is off for `tallo-api` in the dashboard.
  Secrets to delete remotely: `READ_TOKEN` on both Workers. Deploy the API before the web; no D1 or R2 change.

## Session 2026-11-11: public search pivot (issue #72, PR open, not merged)

- Removed: the assistant, resume builder, application tracker, saved searches, profile, status page, access-key
  middleware, `packages/ai`, `packages/resume`, `packages/search-ai`, and the `AI_*` / `OPENCODE_API_KEY` settings.
- Kept: catalog, collection, ingest, admin, runner, `GET /v1/jobs`, `POST /v1/jobs/search`, `GET /v1/jobs/:id`,
  `GET /v1/sources/status`. The web is `/` (home with a search form) and `/search` (plain GET form, results
  paginated server-side, 20 per page, links to each employer's application).
- Migration `0020_drop_personal_tables` drops `profiles`, `resumes`, `applications`, `searches`. It is NOT applied to
  production; the main agent applies it remotely. Numbered after `0019_failure_count`.
- Behaviour change to check: `POST /v1/jobs/search` hits now carry `applyUrl` (the apply link, else the posting page).
  Additive; needed for the results links.
- Open: `/llms.txt` (named in the pivot intro, not in this issue's scope); the web is `noindex` (kept as before; a
  public-site decision); `CLAUDE.md`, `docs/decisions.md` (D15), `docs/architecture.md`, `docs/runbook.md` updated.

## Session 2026-11-11: health check and dead-board prune

- D1 read-only check: 8,688 boards, 0 due or overdue, 0 stuck runs, DLQ empty, 684,781 open jobs, 0 orphan jobs. Partials (146 of 353 runs in 3 days) are all Workday (stopped, 422/403) and Oracle Cloud (short page).
- 31 boards confirmed dead by a live 404 removed from `sources/` and from D1 (546 jobs, 255 runs). Three dead rows answer 200 again (`overstory`, `remotecom`, `remotereferralboardinternaluseonly`) and stay; `workday:cvshealth` stays dead (not re-checked).

## Session 2026-10-29: reviewed AI recommendations

- Issue #56: chat now publishes a reviewed shortlist rather than displaying the last broad title search. Publishing
  validates discovered/read/currently visible ids and source quotes; qualification interpretation remains the model's job.
- More exploration: 40 candidates/page, offset paging to 300, 60 distinct cached description reads, literal passage search
  and contiguous text pages for omitted sections. Limits are 24 model steps and 400k aggregate input tokens per turn.
- Latest-turn publication drives the UI; raw candidates and old shortlists are not fallback recommendations. Saved
  searches remain broad discovery and are explicitly labeled. Catalog facts and D1/R2 storage are unchanged.
- Follow-up #57 records exact/semantic retrieval, description-only locations, factual storage, runtime fit judgments,
  and approximately $5 incremental Cloudflare budget as open architecture questions. No index/vector redesign yet.
- Validation: full pnpm check passed, with additional targeted regression checks. Independent review is recorded on the PR.
  Scripted tool/UI tests cover enforcement;
  they do not establish live-model quality. No deployment performed as part of this change.

## Session 2026-10-28: read this first

**(Superseded 2026-11-21: cloud collection is off, see above.) Collection ran in Cloudflare; the Mac ran nothing.** Cron `*/5` claims due boards (D1 `sources.next_due_at`,
`tier`), a Queue (`tallo-collect`, DLQ `tallo-collect-dlq`) feeds a consumer in `tallo-api` that calls ingest directly,
a Durable Object gates hosts. Default interval is weekly; `sources/hot.json` boards are daily; dead boards 30 days.
Live settings (`apps/api/wrangler.jsonc` and `cloudflare.config.ts`, keep both in step): `COLLECT_ENABLED=1`,
`COLLECT_BATCH=3000`, consumers `max_concurrency=188` (75% of the 250 queue limit), public-platform concurrency 4 per
consumer (`packages/collect/src/policy.ts`). Kill switch: set `COLLECT_ENABLED` to `"0"` and deploy.
Detail: `docs/runbook.md` ("Cloud collection (queue)"), `docs/architecture.md`.

State at stop (22:20 PDT): the first full pass (every board re-fetched, platform version 2) was about 70% done:
Ashby and Lever finished, Greenhouse ~2k, SmartRecruiters ~80, Workday ~180 boards left, dead-letter queue empty, no 429s.
Nothing monitors it now; the cron keeps claiming on its own. Check `GET /v1/admin/collect/status` (ingest token) for
`dueNow`, `inFlight`, `last24h`, and `wrangler queues list` for the DLQ count.

Live in prod from this session: migrations 0016-0018; AI cost guard (`AI_DAILY_TOKEN_LIMIT`, optional `AI_MODEL_FAST`,
optional KV `AI_SPEND`, none set yet); regroup cursor + run-prune indexes; search filter inside the candidate cut,
requisition-id collapse, place aliases (40-case harness in `packages/db/eval`); Retry-After honored in `packages/http`;
159 confirmed-dead boards removed from `sources/`, then 49 more on 2026-10-29 (live 404 re-check; `remotecom` and
`remotereferralboardinternaluseonly` answered 200 and stay). Removing a board from the files does not delete its D1 `sources` row (`register` only upserts), so the 206 dead rows
were deleted by hand with their 77 jobs, 1,274 runs and 18 raw packs (no FKs; delete jobs first for the FTS trigger, and
delete the jobs too or the stale-hide `NOT EXISTS` on `sources` stops hiding them). The two 200 boards stay (dead flag clears
on a complete listing).

First full pass finished 2026-10-28 ~23:00 PDT (9,087 complete, 460 partial). Partials: 339 dead-board 404s, 49 runs reaped
as "stopped before finalize" (34 from the cloud worker, mostly Workday, cause unknown), 37 Workday "posting without
externalPath", 14 Workday 422/403/429, 11 Oracle Cloud "Short page" pagination.

Lessons: `sendBatch` accepts at most 100 messages (a batch of 300 stranded 900 leased boards; fixed, chunked at 100).
`concurrency` in the policy is per invocation, so host-wide in-flight = consumers x concurrency; the DO gate only
enforces a start gap. Local `nohup ... &` jobs get killed; use harness background jobs. The reaper (hourly :17) clears
runs left `running` after 2h; a board with a running run is refused (409) until then.

Next, in order:
1. When `dueNow` is near 0: run `pnpm --filter @tallo/runner tallo dedupe` once (full regroup), then check final stats.
2. Collector hardening (audited against the code, NOT started; no branch). Verified gaps, in this order:
   a. `enqueueDue` (`apps/api/src/collect.ts`) claims (30 min lease) then sends; a throwing `sendBatch` strands the
   unsent boards. Release unsent claims per chunk (`next_due_at = now`); test with a throwing fake queue.
   b. Host-wide load: 188 consumers x concurrency 4 can put ~750 requests on one host (Greenhouse is a single host);
   the DO gate only enforces a start gap and `FAST` has gapMs 0. Add a per-platform DO slot lease with TTL, taken
   once per invocation, AIMD on 429; new fields in `policy.ts` with defaults. Biggest operational risk.
   c. DLQ: `max_retries: 2` with `tallo-collect-dlq`, but nothing consumes it and `message.retry()` has no delay. Add a
   DLQ consumer (record failure, back off `next_due_at`), `retry({delaySeconds})`, an admin list and replay endpoint.
   d. Retry schedule: flat 6h after partial (`SCHEDULE.retryAfterPartial`), no failure count, `busy` (409) is acked
   without rescheduling. Add a failure count on `sources` (additive migration 0019), backoff 1h/3h/6h/24h, a run
   heartbeat plus a stall reaper (the 2h reaper is the only recovery), and an invariant repair in the hourly cron
   (every non-dead board has a future `next_due_at` or a live lease).
   e. Memory: `Plan.changed` keeps full postings in `plan.json`, reloaded every slice; chunk it into per-100 scratch
   parts. Add cleanup of orphaned `work/` objects older than 2 days. `missingBlobs` does one R2 head per new hash.
   f. Alerts (`ALERT_WEBHOOK_URL`: claimed 0 while due, DLQ non-empty, error rate, reaper count, overdue boards) and
   weekly D1 export; port only the alert rules from branch `worktree-agent-a892c135d576e060d`, not launchd.
   g. Tests for double claim, duplicate queue delivery and a replayed continuation. Closure safety already holds by
   design (finalize closes only on a complete listing; replayed start/final slices are no-ops).
   Then apply migration 0019 (`wrangler d1 migrations apply tallo --remote`) and deploy the API.
3. Weekly D1 export and weekly full-sync launchd jobs are in the repo but not installed (#63): see runbook "Weekly full sync" and "Backup and restore". Not yet run against production; rehearse the restore on a scratch D1.
4. Data fidelity branch `worktree-agent-aba2d80d7e13656b8` (Greenhouse pay label, structured country; bumps platform
   versions = another full pass, cheap now) and Greenhouse "See Opening ID" placeholder as unknown requisition id.
5. Porter stemming conflates "accountant"/"Account Executive" (needs an FTS tokenizer migration).
6. Not on any board here: Google, Meta, Apple, Amazon, Microsoft, Netflix, Nvidia (own platforms needed).
7. Done 2026-10-29 (see above). Open: find why cloud Workday runs die before finalize; Workday `externalPath` skips; Oracle short pages.
8. R2 write operations are ~52% of the 1M monthly free allowance; keep PUT/COPY/LIST low. Billing API stays 403 for the
   OAuth login (no billing scope); read Billing -> Usage in the dashboard.
9. About 45 stale agent worktrees/branches under `.claude/worktrees/`; check `git branch --no-merged origin/main` first.
   `~/.claude/projects/-Users-nandan-dev-tallo/HANDOFF-2026-10-26.md` is the old handoff (superseded).

## Done

- Core: contracts, http, catalog, platforms (Greenhouse, Lever, Ashby, SmartRecruiters, Workday), db (Drizzle,
  FTS5, ingest, queries), API Worker, runner CLI, Astro web UI on shadcn components.
- Deployed: API https://tallo-api.nandan.fyi, web https://tallo.nandan.fyi (gated by access key).
- Read-side staleness policy (#2): jobs from sources with no listing for 14 days are hidden; `/v1/sources` has `freshness`.
- Classifier v2 (#13 partly) is superseded: the database holds no heuristics any more (decisions D6). `classify`,
  `CLASSIFIER_VERSION`, `tallo reclassify`, text-parsed pay/experience/location and the `hidden` flag were removed.
- **No heuristics in the database (decisions D6)**. Facts are what sources state; the
  assistant judges relevance, tech vs non-tech, place, pay and seniority. The `pay` line is the source's own base pay in
  its own interval. Visible rows: open, canonical, fresh source. Schema migration `0013_equal_toro` drops `is_us`,
  `is_tech`, `classifier_version`, `hidden`, the annualized salary and experience columns, and recreates `jobs_feed_idx`
  and `jobs_company_idx` without the hidden predicate. Platform `version` is 2 for all six platforms, so the next full
  sync re-maps every posting.
  **Deploy order: migration first, then API, then web, back to back**, then a full sync and `tallo dedupe`
  (`docs/runbook.md`, "Order for the no-heuristics change"). Old API code cannot read the new schema and new API code
  cannot write the old one. Visible results grow: postings the old flag hid are now listed, and the assistant judges them.
- Workflow: stateless GitHub-native process (`docs/workflow.md`), roles in `.claude/agents/`, review checklist.
- Sources seeded from the legacy registry: ~8.9k boards.
- **AI assistant (live 2026-10-26)**: `/` is a chat (left) beside a results list that is the database's answer to the assistant's search (it never writes the list; notes are validated); the old filter UI and `/ask` are gone. One streamed
  tool-using agent (`packages/search-ai`, models via `packages/ai`, default Claude Haiku 5.5 on OpenCode Go), `POST /v1/ai/chat`,
  profile = the built resume plus the person's notes (see UX below), full descriptions never truncated. See `docs/ai-search.md`.
  `OPENCODE_API_KEY` is a Worker secret on `tallo-api`; `AI_MODEL_SMART` is a plain var.
- **Ranked search (relevance, not newest)**: the results list is one FTS MATCH over title phrases (ORed), companies and places
  (ANDed), the best 2000 candidates by bm25, collapsed per company and title with a location count, paged by offset to 300.
  Places are the person's words, expanded by a reviewed table (`packages/catalog/src/places.ts`). The model sees 20 compact
  hit lines. Measured on the 30-request experiment: P@40 0.67 to 0.84, rows read about 4x lower. No migration; the FTS table
  is unchanged. Deploy API, then web (the paging contract changed: `nextOffset`, not `nextCursor`). `GET /v1/jobs` is unchanged.
  See `docs/ai-search.md`. Open: `docs/ai-search.md` "Open".
- Duplicates collapsed (`dedupe_key`, `dup_of`): 508k open rows, 78k collapsed; `last_listed_at` now advances at finalize.
- Deploy policy: deploy to prod right after each change (migrations first). Deploy from a clean worktree of origin/main, not from a
  checkout that background syncs import. Use `pnpm --filter @tallo/api run deploy` (plain `pnpm deploy` is another command).

- **Resume builder (live 2026-10-26, D14)**: `/resume` and `/resume/<posting id>`. Structured resume editor, PDF drawn in the
  browser (react-pdf; fits the page limit by choosing a density), pdf.js preview and PDF-to-text import, assistant
  tailoring per posting (facts guarded in code) and free-form edits with undo. "Tailor resume" is on each posting.
  Migration 0009 `resumes` applied.
  Cleanup done with it: `pnpm check` works again (biome ignores `.claude/` worktrees; ~32 stale agent worktrees remain
  there and can be removed with `git worktree remove` once their branches are confirmed merged), shared `requestJson` /
  `forward` helpers replaced three copies of fetch+error handling, stale lint suppressions removed.

- **Second pass (live 2026-10-26)**: no users, so legacy was removed outright (profile `resume` column, `/profile` and
  `/jobs/<id>` redirects, browser bookmarks, ~20 unused exports and components). New: the **tracker** (saved / applied /
  interviewing / offer / rejected with notes; clicking Apply on a role marks it applied; table `applications` keeps a snapshot
  of the posting), **saved searches** with a count of roles new since last run (`searches`), **fit check** on a posting
  (`POST /v1/resume/fit`, quotes verified in code), **cover letter** per tailored copy (stored in the resume doc, PDF export),
  **dark mode**, deterministic **resume checks** in the editor, **interview prep** on roles at the interviewing stage
  (`POST /v1/resume/prep`), a follow-up nudge on applications a week old, a PDF text round-trip test (headings are real
  words to a parser; letter-spaced headings were removed after it caught them), axe accessibility tests over the main
  screens, and `apps/api/src/app.ts` split into route modules (`jobs`, `assistant`, `resume`, `ingest`, `applications`,
  `searches`). Migrations 0010-0012 applied.

## Infra

| Thing   | Id / location                                                                                                                                  |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| D1      | `tallo` (001b036c-2e15-45c8-9284-edb9d374b849), migrations 0000–0012 applied remotely                                                          |
| R2      | `tallo-blobs`                                                                                                                                  |
| Workers | `tallo-api` (custom domain tallo-api.nandan.fyi, hourly cron at :17 UTC purge), `tallo-web` (tallo.nandan.fyi)                                 |
| Secrets | API: INGEST_TOKEN. Web: none (READ_TOKEN retired by #75). Local copies: `apps/runner/.env`, `~/.config/tallo/web-secrets.env` (both untracked) |
| Zone    | nandan.fyi (Cloudflare). `tallo-assets.nandan.fyi` not used yet                                                                                |

## In flight

- Cloud collection (branch `worktree-agent-a62304caf8f590baa-collect`, not pushed, not deployed, migration `0018_shiny_speed`
  not applied remotely): boards are collected in the `tallo-api` Worker from the queue `tallo-collect` (DLQ
  `tallo-collect-dlq`), scheduled in D1 (`sources.next_due_at`, `sources.tier`; weekly, daily for `sources/hot.json`), with a
  per-host gate in a `HostGate` Durable Object. Shared engine in `packages/collect`. Kill switch `COLLECT_ENABLED` is `"0"`
  in config. Rollout, staged test and rollback: `docs/runbook.md` ("Cloud collection"); design: `docs/architecture.md`
  ("Where collection runs"). Next: queues created, migration applied, staged test with 20 boards, then cron on and the
  launchd job unloaded.
- Write-cost quick wins (branch `write-cost-quick-wins`, not deployed, migrations 0014 and 0015 not applied): unchanged postings
  are not rewritten, the FTS trigger has a `WHEN` guard, absences write only the counter, the purge checks hashes in batches
  of 100 through `jobs_jd_hash_idx`, the feed and company indexes are dropped and `GET /v1/jobs` requires `q`. Deploy order and
  expected writes: `docs/runbook.md` ("write-cost migrations") and `docs/architecture.md` ("Write cost per posting").
- Read-cost branch `db-write-efficiency` (not deployed, migrations 0016 and 0017 not applied; order in `docs/runbook.md`,
  "read-cost migrations"): the hourly regroup starts at a cursor (`regroup_state`, less 30 minutes) instead of a 3-hour
  look-back, and run retention uses indexes (`runs_started_idx`, partial `runs_pack_idx`) instead of three scans of `runs`.
  Not done, on purpose: the FTS `company` column and `columnsize=0` (bm25 ranks by company and doc length, so both would
  change search results); multi-row upserts (D1 bills rows and index entries, not statements, and the changed-columns
  write needs one SET per row); `/status` (8.9k rows per web cache miss; a longer web TTL is the cheap lever, a user-visible
  choice).
- Background syncs (one process per platform, logs `~/Library/Logs/tallo-sync-*.log`) were started 2026-10-26; check they finished,
  then install the daily launchd job (#1).

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

- **Deploy policy:** deploy to prod right after every merge (apply remote migrations, then API + web, then smoke-test).
  Use `pnpm --filter @tallo/api run deploy` (plain `pnpm deploy` is a different command). The unit-test DB is not D1:
  D1-only batch bugs show up in prod, so check `wrangler tail` after deploying DB write paths.
- Live in prod (2026-10-26): migrations 0004 `dead_boards` and 0005 `facet_counts`; dead-board marking (3 consecutive
  first-request 404s; `tallo sources --dead`, `sync --include-dead`), `/status` page, `GET /v1/runs`,
  `GET /v1/sources/status`, `GET /v1/facets` (rebuilt hourly in cron; `POST /v1/admin/facets/rebuild` forces it).
  The facet rebuild scans `jobs_feed_idx` (verified with EXPLAIN QUERY PLAN).

## Merged this session

PR #32 dead boards (#3), #33 source status page (#11), #34 facets (#10), #37 review follow-ups (#36),
#38 facet rebuild hotfix (`db.run` is invalid inside a D1 batch).

PR #18 shared per-host limiter, #19 structured facts on the job page, #20 Oracle Cloud platform
(7 boards; the host-default guard refuses a wrong siteNumber; Tenet board dropped, see #21).

## Next (priority order)

1. Finish #1 (sweep, launchd, usage check). 2. Apply the no-heuristics deploy order, then the full sync that
   re-maps every posting (platform version 2). 3. #3 dead boards, #14 raw pack pruning, #10 facets, #11 status
   page, #6-#8 more platforms, #9 source discovery (needs URL lists), #21 Tenet.

## Known gaps / notes

- Workday slices over 2,000 results that cannot be split report `complete: false` (closure skipped).
- Cloud collection: a listing is not sliced, so a board whose listing alone reaches the 10,000-subrequest hard limit
  fails its run (partial) and should stay on the Mac runner. Raw parts of runs that never close are left in R2 under
  `work/`. `normal` and `rare` have the same one-week interval (the tier is kept for later tuning).
- Oracle finder caps at 10,000 results (see PR #20 notes).
- Pricing/limits were verified from vendor pages on 2026-10; re-verify before large changes.
