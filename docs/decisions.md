# Decisions

Short ADR-style log. Newest first. Add an entry when a choice would otherwise be re-litigated.

**D17. Agent-facing public contract v2 (2026-11-21).** Response `apiVersion` is `"2"`. Search hits add
`compensation` (the source's stated bands verbatim), `employmentType`, `countryCode` and `sourceLastListedAt` (the
board's last complete listing, not a per-posting sighting). `locations` now means the open `dup_of` siblings of the
hit, this one included — the same group `/v1/jobs/:id` lists as `variants` — instead of a count over the candidate
set. Search answers also carry `count`, `hasMore`, `capped`, `expandedLocations`, `remote` and `asOf`; `capped` means
the 300-result cap stopped the list, never that more results exist. `title` is optional when `company` is given.
New discovery endpoints (`/v1/companies`, `/v1/titles`) read small ingest-maintained tables, never a scan of `jobs`.
`/v1/openapi.json` is generated from the same zod schemas as `/llms.txt`. Public answers send
`access-control-allow-origin: *` and answer `OPTIONS`; the contract states that titles and descriptions are untrusted
employer text. Closed postings answer 410 `closed`; absent ids 404 `unknown`; hidden sources 404 `source_hidden`.
Reason: LLM callers were inferring types from prose and could not tell freshness, closed state or why a field was a
number. No value is derived from text; the additions are source-stated facts or pure pagination/freshness metadata.

**D16. Public read API for the user's own AI (issue #75).** `GET /v1/search`, `GET /v1/jobs/:id` and
`GET /v1/jobs/:id/description` are public, GET-only and need no token; they replace the free-text `GET /v1/jobs` and
`POST /v1/jobs/search`. The web Worker forwards exactly the three paths, with a per-address limit and an edge cache, and
serves `/llms.txt` (generated from the same schemas). Reasons: the reader's own AI judges fit, so the API returns facts,
short hits and description chunks, never a whole catalog; cursors are bound to their query so a page cannot be replayed
against another search; errors are written for a model to correct. `READ_TOKEN` is retired. The API's own custom domain
refuses the reads (`READS_BLOCKED_HOST`), so the web's limit and cache cannot be bypassed there (see the runbook).

**D15. Public read-only search; no personal data, no AI in the product.** Tallo serves job search to anyone: the API's
job reads (`GET /v1/jobs`, `POST /v1/jobs/search`, `GET /v1/jobs/:id`) and the web home and `/search` pages, which are
plain HTML forms. The assistant, resume builder, application tracker, saved searches, profile, status page and access-key
cookie are gone, with their tables (migration `0020_drop_personal_tables`) and their packages (`ai`, `resume`, `search-ai`).
Relevance is for the reader: each result links to the employer's application and the reader's own AI can do the judging.
Superseded: D13, D14. Their notes stay below as history.

**D14 (superseded by D15). Resumes are structured data, drawn to PDF in the browser.** A `Resume` (zod, `contracts/resume.ts`) plus a `ResumeStyle`
is the source of truth, stored as JSON in `resumes` (personal layer, keyed by user, `job_id` 0 = base, a posting id = the copy
tailored to it). The PDF is made client-side by `@react-pdf/renderer`: PDF standard fonts, real text in reading order,
and a density search (`DENSITIES`, binary search by page count) that picks the roomiest layout fitting the page limit, so
fitting is code, not a prompt. pdf.js draws the preview (the same on phones) and reads an uploaded PDF's text on the device.
Rejected: LaTeX/WASM (the reference app's route): a 324 MB TeX Live download, LaTeX errors to repair, and a long prompt to make
a model keep to one page. AI never rewrites facts: `applyTailoring` takes employers, titles, dates and schools from the
original and drops any bullet that states a number, or any skill, the resume never contained. Free-form edits are not
held to that, so the UI says so and offers undo. Nothing the model writes is stored until the person edits or saves.

**D13 (superseded by D15). The AI assistant builds the search; the database produces the list.** One streamed `ToolLoopAgent` with `search_jobs`, `read_job`
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

**D9. No per-job `last_seen`.** Presence comes from set difference against each complete listing; this avoids
writing every row every day (~9M writes/month at 300k jobs).

**D8. Closure rule.** Complete, non-empty (or authoritatively empty) listing, absent in 2 consecutive runs. Purge 30 days after closing.

**D7. Heavy data in R2, lean facts in D1.** Descriptions (gzip, content-addressed, text only) and raw run packs in R2.
D1 holds facts, an excerpt and hashes. Keeps D1 small/fast and the 10GB cap irrelevant.

**D6. No heuristics in the database; the reader judges.** The database stores facts the sources stated (structured
fields, the source's own text, hashes). It derives nothing from text: no country, region or city guessed from a place,
no pay or experience parsed from a description, no work mode or US/tech flag, no `hidden` flag. Pay keeps the source's
interval. The reader (a person, or their AI) reads titles, departments, locations and descriptions, and treats unknown as unknown. Rejected:
versioned classifiers with a reclassify job (rules that drift, plus a flag column nobody could trust). Raw packs still keep
every source field, so a future parser could be added and replayed without refetching.

**D5. Drizzle on D1 (SQLite dialect), tests on node:sqlite.** `sqlite-core` keeps the schema portable to libSQL/Turso
or a VPS. Schema source of truth is TypeScript; FTS5 is a custom migration.

**D4. Hono API, Astro web, one Worker each.** Web reaches the API through a service binding. The API uses bearer
tokens; the web pages are public (the access-key cookie was removed in D15).

**D3. Mac is the only runner in v1.** Coordination is a `runs` table, an idempotent `runId` and one running run per
source; no leases or queues until a second runner exists.

**D2. Link out, never repost.** Every job carries the employer's apply URL; full description text is stored for
search, enrichment and (later) resume tailoring.

**D1. Clean start.** New repo, no legacy code or data. Source configs were seeded from the legacy registry's slugs.

## Open / deferred

- Public API redesign: a separate PR. Closed-job history: not planned.
- Accounts and any per-person data: not planned. The product holds no personal data (CLAUDE.md rule 5).
- Cloud runners: when needed, same ingest protocol, plus per-host rate limits that span runners.
