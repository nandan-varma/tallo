# Decisions

Short ADR-style log. Newest first. Add an entry when a choice would otherwise be re-litigated.

**D14. Resumes are structured data, drawn to PDF in the browser.** A `Resume` (zod, `contracts/resume.ts`) plus a `ResumeStyle`
is the source of truth, stored as JSON in `resumes` (personal layer, keyed by user, `job_id` 0 = base, a posting id = the copy
tailored to it). The PDF is made client-side by `@react-pdf/renderer`: PDF standard fonts, real text in reading order,
and a density search (`DENSITIES`, binary search by page count) that picks the roomiest layout fitting the page limit, so
fitting is code, not a prompt. pdf.js draws the preview (the same on phones) and reads an uploaded PDF's text on the device.
Rejected: LaTeX/WASM (the reference app's route): a 324 MB TeX Live download, LaTeX errors to repair, and a long prompt to make
a model keep to one page. AI never rewrites facts: `applyTailoring` takes employers, titles, dates and schools from the
original and drops any bullet that states a number, or any skill, the resume never contained. Free-form edits are not
held to that, so the UI says so and offers undo. Nothing the model writes is stored until the person edits or saves.

**D13. The AI assistant builds the search; the database produces the list.** One streamed `ToolLoopAgent` with `search_jobs`, `read_job`
(full text, never cut) and `explain_jobs` (validated notes). The shared contract is a search spec; the results list is the database's
answer to the assistant's last `search_jobs`, so a model never writes list data and cannot hallucinate it. `packages/ai` maps a role to
any AI SDK provider; `packages/search-ai` has no database imports (`JobsPort`). Resume and edited profile are stored per user; chats are
not. See `ai-search.md`.

**D12. Libraries over hand-rolled machinery.** ky + p-queue (HTTP), html-to-text + entities, i18n-iso-countries,
safe-stable-stringify, Hono, Drizzle, commander, pino. Effect was considered for runner orchestration and skipped:
the flow is linear, so its cost (style, learning curve) outweighs the benefit. Revisit if orchestration grows.

**D11. Platform = list + detail + map + fingerprint in one folder.** Adding a platform touches one folder and one
registry line. `map` is pure code beside the collector; collectors still never touch a database.

**D10. Diff by source fingerprint, not mapped facts.** `sourceHash` = fingerprint(listing) + platform version.
Daily runs fetch details only for changed postings; bumping a platform version re-processes that platform.
Heuristic flags are derived data with their own version: `tallo reclassify` upgrades them from stored facts.

**D9. No per-job `last_seen`.** Presence comes from set difference against each complete listing; this avoids
writing every row every day (~9M writes/month at 300k jobs).

**D8. Closure rule.** Complete, non-empty (or authoritatively empty) listing, absent in 2 consecutive runs. Purge 30 days after closing.

**D7. Heavy data in R2, lean facts in D1.** Descriptions (gzip, content-addressed, text only) and raw run packs in R2.
D1 holds facts, an excerpt and hashes. Keeps D1 small/fast and the 10GB cap irrelevant.

**D6. Heuristics are views, not filters at ingest.** `is_us`/`is_tech` are tri-state; only confident zeros set `hidden`.
Nothing is dropped, so a corrected rule can be replayed from raw packs.

**D5. Drizzle on D1 (SQLite dialect), tests on node:sqlite.** `sqlite-core` keeps the schema portable to libSQL/Turso
or a VPS. Schema source of truth is TypeScript; FTS5 is a custom migration.

**D4. Hono API, Astro web, one Worker each.** Web reaches the API through a service binding. Private in v1:
bearer tokens for the API, access-key cookie for the web UI.

**D3. Mac is the only runner in v1.** Coordination is a `runs` table, an idempotent `runId` and one running run per
source; no leases or queues until a second runner exists.

**D2. Link out, never repost.** Every job carries the employer's apply URL; full description text is stored for
search, enrichment and (later) resume tailoring.

**D1. Clean start.** New repo, no legacy code or data. Source configs were seeded from the legacy registry's slugs
(`scripts/import-legacy-sites.mjs`, one-off).

## Open / deferred

- AI enrichment: table + interface only when first needed. AI search design is in `ai-search.md` (D13).
- Public API, SEO, accounts, personal layer: v2. Closed-job history: not planned.
- Cloud runners: when needed, same ingest protocol, plus per-host rate limits that span runners.
