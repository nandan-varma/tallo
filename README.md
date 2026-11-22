# Tallo

A public, read-only job-search API and a small search page. Tallo collects postings from company ATS boards
(about 9,500 boards on 26 platforms, from Workday and Greenhouse tenants to Walmart, Microsoft and IBM), keeps what each source states, and links every result straight to the employer's
own application page. It stores nothing about people and judges nothing: relevance is the reader's call.
- Site: https://tallo.nandan.fyi (search on the homepage, `/status` for the live numbers)
- API: `GET /v1/search`, `/v1/jobs/:id`, `/v1/jobs/:id/description`, `/v1/companies`, `/v1/titles`, `/v1/openapi.json`
- For AI readers: https://tallo.nandan.fyi/llms.txt (generated from the API's own schemas)

```
sources/*.json ──▶ Mac runner (tallo sync, by hand) ──▶ ingest ──▶ D1 (facts) + R2 (descriptions, raw packs) ◀── API ◀── web
                   cloud collector (built, off) ──────┘
```

## Develop

```sh
pnpm install
pnpm check          # lint, typecheck, tests
pnpm release        # check, migrate D1, deploy API then web, smoke test

# local stack
cd apps/api && printf 'INGEST_TOKEN=dev-ingest\n' > .dev.vars
pnpm exec wrangler d1 migrations apply tallo --local && pnpm dev          # API on :8787
cd ../runner && TALLO_API_URL=http://localhost:8787 TALLO_INGEST_TOKEN=dev-ingest \
  pnpm tallo sync -p greenhouse -n 10
cd ../web && printf 'API_URL=http://localhost:8787\n' > .dev.vars && pnpm dev   # http://localhost:4321/
```

Docs: `docs/runbook.md` (operate), `docs/architecture.md` (design), `docs/adding-a-platform.md`,
`docs/adding-sources.md`, `docs/decisions.md` (why). Agents: start with `CLAUDE.md`.
