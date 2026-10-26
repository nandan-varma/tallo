# AI assistant (as built)

Status: live. A chat on the left, the results list beside it, built on the AI SDK's own architecture: one `ToolLoopAgent`
streamed to the browser as UI messages, rendered from typed tool parts. The assistant helps build the search; **the
database produces the list**. Nothing the model writes is stored; the conversation lives in the browser tab.

## Principles

- The model reads and searches; it does not generate data. The list, every job field and every description come from the
  database. The assistant may add a short note under a job (why it is there), and notes are validated on the server.
- Filters never worked well (many jobs lack department, work mode, pay, experience), so there are none: the assistant turns a
  request into title phrases and places, treats a missing fact as unknown, and reads a whole posting only when it must.
- Depth is budgeted by the loop (`prepareStep` removes `read_job` after 6 reads), not by the prompt.

## The contract: a search spec

`searchSpecSchema` (`packages/contracts/src/ai.ts`): `{ queries: string[1..8], locations?: string[0..8] }`. It is both the input
schema of the agent's `search_jobs` tool and the body of `POST /v1/jobs/search`. The assistant's **last** `search_jobs` call
defines the list the person sees; the web app runs that spec against the database and pages through it (20 a page, newest first).

## Packages

- `packages/ai`: provider registry. Code asks for a role (`smart`), never a provider; switching subscription is an env change
  (`AI_MODEL_SMART=provider:model` plus a secret). Providers: `go` (OpenCode Go, openai-compatible, `supportsStructuredOutputs`),
  `go-anthropic`, `go-responses`, `openai`, `anthropic`, `openrouter`, `custom`.
- `packages/search-ai`: the agent. No database or framework imports; it needs a `JobsPort` (`search`, `lookup`, `read`).
  - `createJobAgent({model, jobs, profile})`: `ToolLoopAgent`, `reasoning: "none"`, `isStepCount(14)`.
  - `search_jobs` (spec in, up to 40 compact hits out), `read_job` (the FULL description, never cut), `explain_jobs` (notes).
  - `read_job` returns only `{found, title, company, chars, facts}` to the client; the full text reaches the model through
    `toModelOutput` from a per-request cache, so it never travels to the browser or back in the next request.
  - `explain_jobs` validates: a note is kept only for a job `lookup` finds visible in the catalog (unknown ids are dropped),
    once per job, with a one-sentence `why` (max 240 chars); a quote is kept only if it appears word for word in a description
    read this turn or in the profile.
  - `generateProfile`: resume text to profile markdown. `JobAgentMessage` (`InferAgentUIMessage`) types the tool parts for the web app.
- `packages/db`: `profiles` (personal layer, keyed by user, CLAUDE.md rule 5): resume and profile markdown, with their own writer.

## API (`apps/api`)

- `POST /v1/ai/chat`: `{messages}` (the whole conversation) in, `createAgentUIStreamResponse` out; loads the saved profile each turn.
- `POST /v1/jobs/search`: a page of the database's answer to a search spec (no model). `GET/PUT /v1/profile` (the person's free-text notes). The agent's profile is the built resume as text plus those notes; nothing is generated.
- `jobs-port.ts`: `search` runs one exact-term (ANDed, quoted) FTS query per phrase, merged round-robin; named places are part of the MATCH
  (`location_text : (...)`, `ftsLocations`), so local jobs are not crowded out by newer ones elsewhere. `searchPage` ORs the phrases
  and pages by keyset cursor. Everything goes through `visibleJobs` (open, canonical, not hidden, fresh source).
- Missing `OPENCODE_API_KEY` or `AI_MODEL_SMART`: 503 with a clear message.

## Web (`apps/web`)

- `/`: `Assistant` island (`client:only`): `useChat<JobAgentMessage>` over `DefaultChatTransport('/api/chat')`; the conversation is kept in
  `sessionStorage`. Data fetching is TanStack Query (`queries.ts`): `useSearchPage` runs `currentSearch(messages)` through `/api/search` and
  keeps the previous page on screen while the next loads (the list never blanks); `useJob` loads a posting once per visit.
- Layout is CSS only: a `data-detail` / `data-tab` attribute on the container switches three columns (chat | results | posting) and flex
  transitions animate it. One tree serves desktop and mobile (Tailwind `lg:` / `max-lg:` variants). Opening a job tucks the chat into a bubble
  and slides the list left (400px) so you can click another job while you read; the bubble or Esc brings the chat back.
- Pieces: `Assistant` (state and layout), `ChatPanel`/`Messages`/`Composer`, `JobList` (+ `JobRow`), `JobPage`, `queries.ts`, `hooks.ts`.
  `lib/assistant.ts` derives everything beside the chat from the messages: `currentSearch`, `notesById`, `activitiesOf`.
- "About you" sheet in the chat: the notes the resume leaves out (roles, pay, places, deal-breakers). The resume has its own page. Bookmarks stay in `localStorage` (`tallo:saved-roles`).
- A posting shows the assistant's note (if any), the full description, facts, and the other locations of the same posting.
- Tests: `Assistant.test.tsx` (jsdom) mounts the real tree with a finished conversation (list, open and switch postings, note, bubble, Esc,
  mobile); `Assistant.stream.test.tsx` replays a recorded production turn (`fixtures/turn.sse`) through the real `useChat`.

## Models on OpenCode Go (measured 2026-10-26)

Default: `go-anthropic:claude-haiku-5-5` (reliable tool calls, 6-12 s per turn). With `supportsStructuredOutputs`, `deepseek-v4.1-flash`,
`qwen3.8-flash`, `kimi-k3`, `mimo-v2.6-flash` honour `json_schema`; `glm-5.x` and `minimax-m3.1-flash` answer in prose; `deepseek-v4-pro`
rejects the format. Re-test a model before using it. Go is for coding-agent traffic and single-member workspaces: fine for private use,
revisit before public use.

## Open

- Results are newest first; relevance ordering would need a rank in the search (FTS bm25) or a score the database can compute.
- A role whose title shares no word with the phrases the model tries is missed (vector recall, issue #16, would sit behind the search).
