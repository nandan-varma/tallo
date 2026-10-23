# Decisions

Short ADR-style log. Newest first. Add an entry when a choice would otherwise be re-litigated.

**D12. Libraries over hand-rolled machinery.** ky + p-queue (HTTP), html-to-text + entities, i18n-iso-countries,
safe-stable-stringify, Hono, Drizzle, commander, pino. Effect was considered for runner orchestration and skipped:
the flow is linear, so its cost (style, learning curve) outweighs the benefit. Revisit if orchestration grows.

**D11. Platform = list + detail + map + fingerprint in one folder.** Adding a platform touches one folder and one
registry line. `map` is pure code beside the collector; collectors still never touch a database.

**D10. Diff by source fingerprint, not mapped facts.** `sourceHash` = fingerprint(listing) + platform version +
classifier version. Daily runs fetch details only for changed postings; bumping a version re-processes everything.

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

- AI enrichment: table + interface only when first needed; Vercel AI SDK for bring-your-own-provider keys. Heuristics first.
- Public API, SEO, accounts, personal layer: v2. Closed-job history: not planned.
- Cloud runners: when needed, same ingest protocol, plus per-host rate limits that span runners.
