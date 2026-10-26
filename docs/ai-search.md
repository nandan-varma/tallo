# AI search (design)

Status: design agreed 2026-10-26, nothing built. Decision log entry: D13 in `decisions.md`.

## Problem

Structured filters do not work well: much of the catalog has missing or wrong facts (department, work mode,
pay, experience). The goal is a non-deterministic chat search that reads titles and the little data we have,
ranks by fit to a saved profile, returns empty where a fact does not exist, and goes deep (reads a description)
only when it must. Generated output is **not stored** while the engine is being tuned.

## Packages

- `packages/ai`: provider config only. A `createProviderRegistry` built from env. Code asks for a **role**
  (`fast`, `smart`), never a provider. Providers: `go` (OpenCode Go, openai-compatible), `go-anthropic`,
  `go-responses`, `openai`, `anthropic`, `openrouter`, `custom` (any OpenAI-compatible base URL).
  Switching subscription = changing `AI_MODEL_FAST` / `AI_MODEL_SMART` (`provider:model`) and a secret.
- `packages/search-ai`: the engine. No D1, Hono or Astro imports. Depends on `ai`, `zod`, `@tallo/contracts`
  and a `JobsPort` the host implements (`recall`, `facts`, `description`). Hosts: the API Worker (direct
  `@tallo/db`) and the runner CLI (over REST).
- Profile storage lives in `packages/db` (personal tables keyed by user, never in the shared catalog tables).

## OpenCode Go

Base `https://opencode.ai/inference/go/`: `/openai/v1/chat/completions` (GLM, Kimi, DeepSeek, MiMo, ...),
`/anthropic/v1/messages` (Claude Haiku 5.5, MiniMax M3, Qwen), `/openai/v1/responses` (Grok, GPT Luna).
`GET /inference/go/v1/models` lists live ids. Send our own User-Agent and a stable `x-opencode-session`
per conversation. Go is meant for coding-agent traffic and single-member workspaces: fine for private v1,
revisit before any public use. Reasoning models (e.g. `glm-5.3-flash`) spend `max_tokens` on reasoning and
can return empty content, so every call sets an explicit output budget and models are tested for it.

## Pipeline (per query, stateless)

1. **Understand** (fast): request + profile -> intent: target and adjacent titles, seniority, must-haves,
   deal-breakers. Not structured filters.
2. **Recall** (no model): several FTS queries from the title variants, merged, a few hundred candidates.
   Only impossible rows are excluded (closed, hidden, stale). Vector recall (#16) later, same `recall` port.
3. **Triage** (fast, batches of ~100): per candidate `strong | maybe | no` from title, company, location and
   whatever facts exist. Missing facts stay `unknown`; nothing is invented.
4. **Deep** (smart, budgeted ~10 reads): only for `maybe` rows near the cut. `description` is never truncated:
   one part is judged whole; an oversized one is read in consecutive parts (24k chars each, notes carried
   forward). More than `maxDescriptionParts` (8) parts fails the search loudly instead of cutting the tail.
   Scores fit against the profile with quoted evidence.
5. **Answer**: ranked best fit first; each item has a one-line reason, evidence, and an explicit unknown list.

Rule: when the input is already known (e.g. one job's requirements) use one `generateText` with
`Output.object`; use the agent loop only for open-ended retrieval. Budgets (`stopWhen`, `maxOutputTokens`,
deep-read count) are enforced in `prepareStep`, not by prompt.

## Profile

Resume (pasted text or markdown) -> one-shot structured call -> `profile` (skills, years by area, titles,
preferences, deal-breakers) plus a markdown rendering the user can edit. The resume and the edited
`profile.md` are stored per user; search results, rankings and fit judgments are never stored.

## Tuning loop (before any UI)

`tallo ask "<q>" --profile profile.md --model <role-or-id> --trace` prints per-stage candidates, decisions,
tool calls and tokens. A fixtures file asserts behaviours (no description reads for obvious rejects;
empty answer when nothing fits). Compare engines (model mixes, recall strategies) on quality vs tokens/cost.
Logs never include content outside the CLI trace.

## Surfaces

The API endpoint `POST /v1/ai/ask` (read token; lands with #44, not on this branch) returns one JSON `{ answer, trace }` response. It is not
streamed: the whole search (recall, triage, deep reads) finishes before the response is sent.

`apps/web` proxies it at `POST /api/ai/ask` (same-origin, behind the access-key cookie). The proxy reads the
body as JSON with a 32 KB cap: a non-JSON content-type gets 415, a body over the cap gets 413 (checked on the
declared Content-Length and again on the bytes actually read), and invalid JSON or an out-of-range
query/profile gets 400. The page's only `client:*` is `AskPanel`, a small React island that calls the proxy
with `fetch` (no chat or streaming client). It owns cancel and a 180 s timeout via `AbortController`, and
validates the response shape before rendering. The profile is kept in `localStorage` on the device only.
The AI key is a Worker secret and never reaches the browser.

## Duplicates (as built, #47)

One posting listed once per location is one row per location. `jobs.dedupe_key` (catalog `dedupeKey`:
normalized company, normalized title, `jd_hash`, versioned by `DEDUPE_VERSION`) groups them. `jobs.dup_of`
is the canonical row's id (lowest open id) and NULL for canonical and ungrouped rows. Search and facets read
canonical rows only (`visibleJobs`, the shared predicate); `variants` counts a group and the job page lists
every open location. Recall is design intent only: no recall code exists yet, and it must use `visibleJobs`.
- A group is open rows sharing a key, `hidden` flag and freshness. Splitting on the last two keeps a
  hidden or stale canonical from hiding a visible duplicate.
- `rebuildDuplicates` (ingest.ts, the only writer) regroups the keys of rows written in a 3-hour window
  (`jobs_updated_idx`), the open duplicates of canonicals written in it, and the keys of sources that crossed
  the stale threshold. Closure and reopen bump `updated_at`, so they are in the window.
- **Freshness lag, stated honestly.** A sync's finalize regroups the keys its own rows were written under, so
  a canonical that closes, reopens or changes `hidden` in a sync takes effect at that finalize. A stale source
  that lists again (its `last_listed_at` advances, so its rows un-hide) regroups every key it has, at that
  finalize. Changes that
  never finalize wait for the hourly cron: a stale source crossing `STALE_HIDE_DAYS`, reclassify, and a run
  that never finished. Worst case is one hour (the cron interval) during which a visible duplicate can stay
  hidden behind a closed, hidden or stale canonical. Nothing is hidden for longer, and no job is closed by it.
- Operator steps after the migration: `tallo dedupe` (backfills keys by id cursor, then a full regroup). Until the
  full regroup runs, un-keyed rows stay visible as before, so nothing is hidden by a missing backfill.
  `POST /v1/admin/dedupe?full=true&after=…` walks every key.
- Batches: writes are `json_each` id lists, at most 50 statements per `batch()`, at most 2 bound parameters
  per statement. D1 documents no batch-size cap, so 50 is a budget choice (one short transaction each).
- Known trade-off: distinct requisitions with the same title, JD and city collapse into one card; the job
  page still lists each one with its apply URL.

### Rows read and written (estimates, production, Oct 2026)

Inputs, read-only from production on Oct 26, 2026: 486,777 open rows (the count moves with syncs), 8,894
sources (8,895 rows read by the `sources` scan), about 400k distinct keys, 84k rows in 16k multi-row groups
(measured on the raw key), about 68k rows that will carry `dup_of`. Changed postings per day are estimated at 1
to 3% of open rows (the runner's `diff` sends only new or changed postings).

Measured: the `sources` scan (8,895 rows, `cf d1 query`). Plans: `EXPLAIN QUERY PLAN` on a local SQLite built
from migrations 0000 to 0006 with 8,894 sources and about 476k open rows (synthetic data, with and without
`ANALYZE`). Production has no dedupe columns until 0006 is applied, so the D1 plans cannot be read yet. Other
figures are estimates.

| Pass                                                                                          | Rows read                                                                               | Rows written                                          |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Hourly stale branch, before the fix (`jobs_dedupe_idx` walk, plus a `sources` lookup per row) | about 0.95M per pass, about 23M per day (about 0.48M index entries and as many lookups) | regroup only                                          |
| Hourly, quiet hour (`sources` scan of 8,895 boards, measured, plus the window)                | about 9k: the scan, plus a few hundred window rows                                      | 0                                                     |
| Hourly, busy hour (a few thousand changed rows)                                               | about 15k to 25k                                                                        | only rows whose `dup_of` changed                      |
| Hourly window without `jobs_updated_idx` (full scan of `jobs`, estimate)                      | about 0.5M per pass                                                                     | regroup only                                          |
| Finalize regroup (per source, per sync)                                                       | the source's rows, about 0.47M per daily sync                                           | 0 in steady state                                     |
| One-off `tallo dedupe`: backfill                                                              | about 0.47M (id cursor)                                                                 | about 0.94M (row plus `jobs_dedupe_idx` entry)        |
| One-off `tallo dedupe`: full regroup                                                          | about 0.87M (key index walk plus group rows)                                            | about 0.14M (68k rows plus `jobs_dup_of_idx` entries) |

The stale-source branch is driven from `sources`: the crossed source ids (a scan of the small table), then their
keys by `jobs_source_posting_idx`. A board crossing the threshold reads that board's rows once; the average is
about 55 open rows per board. The old query joined `jobs` to `sources` and walked every open keyed row each hour.

The old backfill query had no index on `dedupe_key IS NULL`, so every page scanned from the start of the table:
about N²/600, roughly 370M rows read for 470k rows. The id cursor reads each row once.
