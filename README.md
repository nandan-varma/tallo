# Tallo

Job discovery that links straight to the employer. Tallo collects postings from company ATS boards
(Greenhouse, Lever, Ashby, SmartRecruiters, Workday, more to come), keeps a lean searchable catalog,
and never reposts: every job has an apply link to the employer's own page.

Scope: public read-only job search (home and `/search` pages, `/v1/jobs` API), daily refresh from a Mac. See `docs/architecture.md` and `docs/decisions.md` (D15).

```
Mac runner ──collect/map──▶ API Worker ──▶ D1 (facts) + R2 (descriptions, raw packs) ◀── Astro web
```

## Quick start

```sh
pnpm install
pnpm check                                  # lint, typecheck, tests

# local stack
cd apps/api && printf 'READ_TOKEN=dev-read\nINGEST_TOKEN=dev-ingest\n' > .dev.vars
pnpm exec wrangler d1 migrations apply tallo --local && pnpm dev          # API on :8787
cd ../runner && TALLO_API_URL=http://localhost:8787 TALLO_INGEST_TOKEN=dev-ingest \
  pnpm tallo sync -p greenhouse -n 10
cd ../web && printf 'READ_TOKEN=dev-read\nAPI_URL=http://localhost:8787\n' > .dev.vars
pnpm dev                                    # open http://localhost:4321/
```

Docs live in `docs/`. Agents: start with `CLAUDE.md`.
