# Progress

_Last updated: 2026-10-26 (ranked search by relevance; no heuristics in the database; tracker, saved searches, fit, cover letter, dark mode)._ Stateless handoff: also read `gh issue list` and `gh pr list` (see `docs/workflow.md`).

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

| Thing   | Id / location                                                                                                                                      |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1      | `tallo` (001b036c-2e15-45c8-9284-edb9d374b849), migrations 0000–0012 applied remotely                                                              |
| R2      | `tallo-blobs`                                                                                                                                      |
| Workers | `tallo-api` (custom domain tallo-api.nandan.fyi, hourly cron at :17 UTC purge), `tallo-web` (tallo.nandan.fyi)                                     |
| Secrets | API: READ_TOKEN, INGEST_TOKEN. Web: READ_TOKEN, ACCESS_TOKEN. Local copies: `apps/runner/.env`, `~/.config/tallo/web-secrets.env` (both untracked) |
| Zone    | nandan.fyi (Cloudflare). `tallo-assets.nandan.fyi` not used yet                                                                                    |

## In flight

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
- Oracle finder caps at 10,000 results (see PR #20 notes).
- Pricing/limits were verified from vendor pages on 2026-10; re-verify before large changes.
