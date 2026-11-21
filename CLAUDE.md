# CLAUDE.md

Tallo is a public, read-only job-search API and a small web search page. It collects job postings from company
ATS boards and links straight to the employer's application. The database stores what sources state; relevance is
judged by whoever reads the results (a person, or their own AI). Nothing personal is stored. The design keeps the
door open to other occupations and countries.

Read `docs/PROGRESS.md` first when resuming: what exists, what is settled, what is accepted as a limit.

## Shape

pnpm workspace, TypeScript everywhere, no build step (Node runs `.ts`; Wrangler/Vite bundle).

| Path                 | Role                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/contracts` | Shared types and zod schemas. Pure data. Never edited to add a platform.                                                                               |
| `packages/http`      | Outbound HTTP (ky + p-queue): retries, per-host limits, https/allowlist/SSRF guard, size caps.                                                         |
| `packages/catalog`   | Pure normalization: HTML→text, hashing, dedupe keys, `prepareJob`. Derives nothing from text (no heuristics).                                          |
| `packages/platforms` | One folder per ATS: `list` + optional `detail` + pure `map` + `fingerprint`. Registered in `src/index.ts`.                                             |
| `packages/db`        | Drizzle schema + migrations (`drizzle/`), `ingest.ts` (the only write path), `queries.ts`, `BlobStore`.                                                |
| `apps/api`           | Hono Worker: public read API (`/v1/search`, `/v1/jobs/:id`, `/v1/jobs/:id/description`, no auth) + ingest/admin (INGEST_TOKEN). D1 + R2.               |
| `apps/web`           | Astro SSR pages (home, `/search`, `/llms.txt`) and the public proxy `/v1/*` (allowlist, rate limit, edge cache). Talks to the API via service binding. |
| `apps/runner`        | Mac CLI (`tallo sync`, `verify`, `register`, ...). Collects the `egress: local` boards, runs by hand.                                                  |
| `sources/*.json`     | Board configs, one array per platform. Reviewed, trusted configuration.                                                                                |

## Rules that must not be broken

1. **Collectors are lossless.** `list`/`detail` keep every field the source returns; `map` is pure and reads
   explicitly (no object spreads, so `tallo verify` can report unread fields). Unknown facts stay NULL.
2. **A failed or partial run never closes jobs.** Closure needs `listing.complete` and a non-empty (or
   authoritatively empty) listing, then `CLOSE_AFTER_ABSENT_RUNS` (2) consecutive complete absences.
   A platform that cannot finish listing must throw or return `complete: false`.
3. **`packages/db/src/ingest.ts` is the only writer** of catalog tables. D1 has no interactive
   transactions: multi-statement writes go through `batch()`; never bind more than ~100 params
   (use `json_each` for id lists).
4. **The database stays lean.** No descriptions, no raw payloads in D1. Description text is gzip in R2
   (`jd/<sha256>`); raw source payloads are per-run packs (`raw/<source>/<run>.ndjson.gz`).
5. **No personal data exists.** The catalog and the site hold only what sources state; nothing is stored per
   person.
6. **Source config is trusted.** Never fetch a user-supplied URL. Every request passes the platform's
   host allowlist (`Platform.hosts`).
7. **No heuristics in the database.** Facts are what a source stated (structured fields only); relevance, tech vs
   non-tech, place, pay and seniority are judged by the reader. Changing a platform's `map`: bump its `version`;
   the next sync re-fetches and re-maps every posting of that platform.
8. Schema source of truth is `packages/db/src/schema.ts`; generate migrations with
   `pnpm --filter @tallo/db exec drizzle-kit generate`, never hand-edit generated SQL (FTS is a custom migration).

## Commands

```
pnpm check                      # lint + typecheck + tests (run before every commit)
pnpm release                    # check, migrate D1, deploy API then web, smoke test (scripts/smoke.ts)
pnpm test                       # vitest, all packages
pnpm fix                        # biome autofix
pnpm --filter @tallo/runner tallo sync -p greenhouse -n 20     # collect + upload (needs TALLO_* env)
pnpm --filter @tallo/runner tallo verify greenhouse:stripe     # dry-run quality report
pnpm --filter @tallo/api dev     # local Worker (D1/R2 emulated)
pnpm --filter @tallo/web dev     # Astro dev server
```

Env (runner, `apps/runner/.env`): `TALLO_API_URL`, `TALLO_INGEST_TOKEN`, optional `TALLO_RUNNER_ID`.
Secrets live in Wrangler secrets / `.dev.vars` / `.env`, all gitignored. Never commit a token.

## Conventions

- Small, plain code. Prefer a library to hand-rolled machinery. No abstraction without a second user.
- Relative imports use the `.ts` extension. `erasableSyntaxOnly`: no enums, no constructor parameter properties.
- Biome formats and lints (`.astro` files are excluded; keep them tidy by hand).
- UI: compose from `apps/web/src/components` (reusable React components rendered server-side, no hydration)
  built on shadcn primitives (`pnpm dlx shadcn@latest add <name>` inside `apps/web`). Pages stay thin. Prefer
  native HTML forms and links over client state; add `client:*` only when interactivity truly needs it.
- Tests sit next to the package (`test/`), use recorded fixtures for platforms, and fake `Http`/`fetch`
  instead of the network. Live checks go through `tallo verify`, not the test suite.
- Commit messages: imperative, no AI attribution lines. Work on a branch and open a PR.

## Deeper docs

`docs/architecture.md` (design, data model, protocol) · `docs/adding-a-platform.md` ·
`docs/adding-sources.md` · `docs/runbook.md` (deploy, secrets, schedule) · `docs/platforms.md` (status) ·
`docs/decisions.md` (why).
