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
4. **Deep** (smart, budgeted ~10 reads): only for `maybe` rows near the cut. The **full** description is read:
   the important facts (pay, minimum requirements) are usually at the bottom, so text is **never truncated**.
   If a description exceeds the model's context it is read in consecutive chunks (all of them), not cut.
   Cost is controlled by how many jobs get a deep read, never by shortening one. Scores fit against the
   profile with quoted evidence.
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

`POST /v1/ai/ask` (read token, streamed `createAgentUIStreamResponse`), then a small chat island in
`apps/web` (`useChat`; the one justified `client:*`). AI key is a Worker secret.

## Duplicates

A posting listed for several locations, or the same job on two boards, is many rows with one description.
Rows are never deleted (collectors stay lossless). `jobs.dedupe_key` = hash(normalized company, normalized title,
`jd_hash`); `jobs.dup_of` points non-canonical open rows at the canonical one (lowest open id in the group).
Search, facets and recall read canonical rows only (`dup_of IS NULL`) and carry the variant count/locations,
so the engine and the UI never see a job twice. `dup_of` is recomputed by a rebuild (cron + admin endpoint).
