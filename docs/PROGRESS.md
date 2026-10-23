# Progress

_Last updated: 2026-10-23 (initial implementation session)._

## Done

- Workspace, contracts, http, catalog, platforms (Greenhouse, Lever, Ashby, SmartRecruiters, Workday), db (Drizzle,
  FTS5, ingest, queries), API Worker, runner CLI, Astro web app. 69 tests, lint and typecheck clean.
- Local full-stack run verified (wrangler dev + runner sync of 12 Greenhouse boards).
- Sources seeded from legacy registry: ~8.9k boards across the five platforms.
- Docs: CLAUDE.md, architecture, runbook, platform guides, decisions, orchestration.

## In flight / next

See GitHub issues (`gh issue list`). Highest value: deploy to Cloudflare, first full sweep, read-side staleness
policy, per-host rate limits, more platforms (Oracle, Eightfold, iCIMS, Workable, ...), facets/filters in the UI.

## Infra (fill in as provisioned)

- D1 `tallo`: _pending_
- R2 `tallo-blobs`: _pending_
- Workers `tallo-api`, `tallo-web`: _pending_
- Domains: tallo.nandan.fyi (web), tallo-api.nandan.fyi (API)

## Open questions

- Pricing and limits were verified from vendor pages on 2026-10; re-verify before large changes.
