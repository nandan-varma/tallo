# AI assistant (as built)

Status: live. Chat on the left, ranked results on the right, built on the AI SDK's own architecture: one
`ToolLoopAgent`, streamed to the browser as UI messages, rendered from typed tool parts. Nothing the model writes is
stored; the conversation lives in the browser tab.

## Why this shape

Filters never worked well (many jobs lack department, work mode, pay, experience), so the assistant ignores them:
it reads titles and the few facts a hit carries, treats a missing fact as unknown, reads a whole posting only when it
has to, and ranks against the person's profile. The earlier multi-stage JSON pipeline (understand, recall, triage, deep)
was removed: it fought the SDK (structured output on models that ignore `response_format`, 128 s per search, nothing to
show until the end). The agent does the same work in tool calls and streams every step.

## Packages

- `packages/ai`: provider registry. Code asks for a role (`smart`), never a provider; switching subscription is an env change
  (`AI_MODEL_SMART=provider:model` plus a secret). Providers: `go` (OpenCode Go, openai-compatible, with
  `supportsStructuredOutputs`), `go-anthropic`, `go-responses`, `openai`, `anthropic`, `openrouter`, `custom`.
- `packages/search-ai`: the agent. No database or framework imports; it needs a `JobsPort` (`search`, `read`).
  - `createJobAgent({model, jobs, profile})`: `ToolLoopAgent`, `reasoning: "none"` (tool routing needs no thinking tokens),
    `isStepCount(14)`, and `prepareStep` that removes `read_job` after 6 reads (depth is budgeted by the loop, not the prompt).
  - Tools: `search_jobs` (several 2-3 word title phrases plus optional `locations`, up to 40 compact hits), `read_job` (the FULL description, never cut),
    `show_jobs` (publishes the ranking, up to 30 matches, to the results panel; the panel pages it ten at a time). Instructions: `prompt.ts`.
  - `read_job` returns only `{found, title, company, chars, facts}` to the client; the full text reaches the model through
    `toModelOutput` from a per-request cache, so it never travels to the browser or back in the next request.
  - `show_jobs` drops any evidence quote that is not verbatim in a description it read or in the profile.
  - `generateProfile`: resume text to profile markdown (plain `generateText`).
  - `JobAgentMessage` (`InferAgentUIMessage`) types the tool parts for the web app.
- `packages/db`: `profiles` (personal layer, keyed by user, CLAUDE.md rule 5): resume and profile markdown. Separate writer
  (`profile.ts`), never touched by the catalog write path.

## API (`apps/api`)

- `POST /v1/ai/chat`: `{messages}` (the whole conversation) in, `createAgentUIStreamResponse` out. Loads the saved profile each turn.
  Errors reach the client as one generic message; logs carry error names only.
- `GET/PUT /v1/profile`, `POST /v1/profile/generate` (nothing saved until PUT). The read token may save its own profile (v1: one user).
- `jobs-port.ts`: `search` runs one exact-term (ANDed, quoted) FTS query per phrase, 20 each, merged round-robin; named places are part of
  the MATCH (`location_text : (...)`, `ftsLocations`), so local jobs are not crowded out by newer ones elsewhere; `read` returns the
  gunzipped description. Both use `visibleJobs` (open, canonical, not hidden, fresh source), so the agent never sees a hidden job.
- Missing `OPENCODE_API_KEY` or `AI_MODEL_SMART`: 503 with a clear message.

## Web (`apps/web`)

- `/`: `Assistant` island (`client:only`), `useChat<JobAgentMessage>` over `DefaultChatTransport('/api/chat')`. `/api/chat` streams the
  upstream body through unchanged. The conversation is kept in `sessionStorage`.
- Results derive from the messages (`lib/assistant.ts`): hits from `search_jobs`, ranking from the latest `show_jobs`, shown while it
  streams and replaced by the server-checked output when done.
- Opening a result tucks the chat into a bubble (shared `layoutId` orb) and opens the listing with the cited quotes marked in the
  description; the bubble restores chat and results. Mobile: tabs plus a full-screen listing.
- `/profile`: paste a resume, build the profile with the model, edit it, save.
- Bookmarks stay in `localStorage` (`tallo:saved-roles`).

## Models on OpenCode Go (measured 2026-10-26)

Default: `go-anthropic:claude-haiku-5-5` (reliable tool calls, ~14 s for a search with reads). With `supportsStructuredOutputs`,
`deepseek-v4.1-flash`, `qwen3.8-flash`, `kimi-k3`, `mimo-v2.6-flash` honour `json_schema`; `glm-5.x` and `minimax-m3.1-flash` answer in
prose; `deepseek-v4-pro` rejects the format. Re-test a model before using it. Go is for coding-agent traffic and single-member
workspaces: fine for private use, revisit before public use.

## Open

- Search quality is bounded by the title index: a role whose title shares no word with the phrases the model tries is missed
  (vector recall, issue #16, would sit behind `JobsPort.search`).
- Ranking is as good as the model's read of the visible facts; unread jobs are marked "possible" and carry an unknowns list.
