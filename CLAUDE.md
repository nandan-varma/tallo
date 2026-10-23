# CLAUDE.md

Tallo is a job discovery platform: it collects US software/tech jobs from company ATS boards and
links straight to the employer's application. v1 is private and for one user; the design keeps the
door open to public use, other occupations and countries.

Read `docs/PROGRESS.md` first when resuming. It says what is done, what is next and what is open.

## Shape

pnpm workspace, TypeScript everywhere, no build step (Node runs `.ts`; Wrangler/Vite bundle).

| Path                 | Role                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| `packages/contracts` | Shared types and zod schemas. Pure data. Never edited to add a platform.                                        |
| `packages/http`      | Outbound HTTP (ky + p-queue): retries, per-host limits, https/allowlist/SSRF guard, size caps.                  |
| `packages/catalog`   | Pure normalization: HTML→text, locations, pay/experience extraction, US/tech heuristics, hashing, `prepareJob`. |
| `packages/platforms` | One folder per ATS: `list` + optional `detail` + pure `map` + `fingerprint`. Registered in `src/index.ts`.      |
| `packages/db`        | Drizzle schema + migrations (`drizzle/`), `ingest.ts` (the only write path), `queries.ts`, `BlobStore`.         |
| `apps/api`           | Hono Worker: internal read API + ingest endpoints. Bearer tokens. D1 + R2.                                      |
| `apps/web`           | Astro SSR UI (private, access-key cookie). Talks to the API via service binding.                                |
| `apps/runner`        | Mac CLI (`tallo sync                                                                                            | verify | sources`). Collects, maps, uploads. |
| `sources/*.json`     | Board configs, one array per platform. Reviewed, trusted configuration.                                         |

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
5. **Public/shared data never holds personal data.** Personal fit, preferences, resumes come later and
   live in separate tables keyed by user.
6. **Source config is trusted.** Never fetch a user-supplied URL. Every request passes the platform's
   host allowlist (`Platform.hosts`).
7. **Heuristics are versioned.** Changing `catalog/classify.ts` rules: bump `CLASSIFIER_VERSION`.
   Changing a platform's `map`: bump its `version`. Both force re-processing of changed postings.
8. Schema source of truth is `packages/db/src/schema.ts`; generate migrations with
   `pnpm --filter @tallo/db exec drizzle-kit generate`, never hand-edit generated SQL (FTS is a custom migration).

## Commands

```
pnpm check                      # lint + typecheck + tests (run before every commit)
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
- Tests sit next to the package (`test/`), use recorded fixtures for platforms, and fake `Http`/`fetch`
  instead of the network. Live checks go through `tallo verify`, not the test suite.
- Commit messages: imperative, no AI attribution lines. Work on a branch, open a PR, link the issue.

## Team workflow

See `docs/orchestration.md`. In short: GitHub issues are the backlog; each issue gets a branch and PR;
cheap (haiku) subagents do bounded work and review one another's PRs; the main agent integrates and owns
architecture. Update `docs/PROGRESS.md` at the end of every working session.

## Deeper docs

`docs/architecture.md` (design, data model, protocol) · `docs/adding-a-platform.md` ·
`docs/adding-sources.md` · `docs/runbook.md` (deploy, secrets, schedule) · `docs/platforms.md` (status) ·
`docs/decisions.md` (why).
