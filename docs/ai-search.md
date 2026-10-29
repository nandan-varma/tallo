# AI assistant (as built)

Status: live. A chat on the left, the results list beside it, built on the AI SDK's own architecture: one `ToolLoopAgent`
streamed to the browser as UI messages, rendered from typed tool parts. The assistant helps build the search; **the
database produces the list**, most relevant first. Nothing the model writes is stored; the conversation lives in the browser tab.

## Principles

- The model reads and searches; it does not generate data. The list, every job field and every description come from the
  database. The assistant may add a short note under a job (why it is there), and notes are validated on the server.
- The catalog is global and unfiltered: every kind of work and every place the sources list. The database judges nothing
  (no US/tech flag, no hidden rows, no pay or experience filters; decisions D6). The database ranks by how well the titles
  match. The assistant judges relevance, tech vs non-tech, place, pay and seniority from titles, departments, location text
  and descriptions. It turns a request into title phrases, companies and places, leaves out hits that do not fit (and says
  so), treats a missing fact as unknown, and reads a whole posting only when it must.
- Pay is quoted as the source stated it: the `pay` line is the base pay in the interval the source gave ("USD 90000-95000
  per hour"). The assistant never converts it to a yearly figure as if the source had said so.
- Depth is budgeted by the loop (`prepareStep` removes `read_job` after 6 reads), not by the prompt.

## The contract: a search spec

`searchSpecSchema` (`packages/contracts/src/ai.ts`): `{ queries: string[1..8], companies?: string[0..4], locations?: string[0..8] }`.
It is both the input schema of the agent's `search_jobs` tool and the body of `POST /v1/jobs/search` (with `offset` and
`limit`). `queries` are title phrases (every word must match, as a whole word); `companies` match the company name and are
ANDed with the titles; `locations` are the person's own place words, expanded on the server (see Places below). The assistant's
**last** `search_jobs` call defines the list the person sees; the web app runs that spec against the database and pages
through it (20 a page, at most `SEARCH_RESULT_CAP` = 300 in total).

## Packages

- `packages/ai`: provider registry. Code asks for a role (`smart`), never a provider; switching subscription is an env change
  (`AI_MODEL_SMART=provider:model` plus a secret). Providers: `go` (OpenCode Go, openai-compatible, `supportsStructuredOutputs`),
  `go-anthropic`, `go-responses`, `openai`, `anthropic`, `openrouter`, `custom`.
- `packages/search-ai`: the agent. No database or framework imports; it needs a `JobsPort` (`search`, `lookup`, `read`).
  - `createJobAgent({model, jobs, profile})`: `ToolLoopAgent`, `reasoning: "none"`, `isStepCount(14)`.
  - `search_jobs` (spec in, up to 20 hits out), `read_job` (the FULL description, never cut), `explain_jobs` (notes).
  - `search_jobs` reaches the model as one line per hit through `toModelOutput`: `id | title | company | location | work mode |
    pay | posted date | department | N locations`, with unknown fields left out (`hitLines`). The browser gets the structured hits.
  - `read_job` returns only `{found, title, company, chars, facts}` to the client; the full text reaches the model through
    `toModelOutput` from a per-request cache, so it never travels to the browser or back in the next request.
  - `explain_jobs` validates: a note is kept only for a job `lookup` finds visible in the catalog (unknown ids are dropped),
    once per job, with a one-sentence `why` (max 240 chars); a quote is kept only if it appears word for word in a description
    read this turn or in the profile.
  - `generateProfile`: resume text to profile markdown. `JobAgentMessage` (`InferAgentUIMessage`) types the tool parts for the web app.
- `packages/catalog/src/places.ts`: the place lookup (see Places). Pure data and one function, `expandPlaces`.
- `packages/db`: `profiles` (personal layer, keyed by user, CLAUDE.md rule 5): resume and profile markdown, with their own writer.
  `queries.ts`: `rankedJobs` (the results list), `countPostedSince` (saved-search new counts), `searchJobs` (newest first, for `GET /v1/jobs`).

## Places

`expandPlaces` (`packages/catalog/src/places.ts`) maps each word the person gave to the strings postings use: "NYC" to the
New York metro, "Bay Area" to the Bay Area cities, "Washington" to the state (Seattle metro and "WA"), "Washington DC" or "DC" to the
capital, "remote" to a work-mode match. It is a reviewed alias table, not inference: a word it does not know passes through as the
person wrote it. The table is loaded with a guard that refuses a name claimed by two places. Collisions it avoids on purpose: the
bare "LA" (Louisiana) is never a token ("la" means Los Angeles), "NY" and "WA" are never inside a city list, and "Washington"
means the state. Known limits: "London" and "Dublin" match the same words in other countries and states.

The model passes the person's own words. It does not expand states or cities itself; the server does, so a table change applies
to saved searches too.

## API (`apps/api`)

- `POST /v1/ai/chat`: `{messages}` (the whole conversation) in, `createAgentUIStreamResponse` out; loads the saved profile each turn.
- `POST /v1/jobs/search`: one page of the database's answer to a search spec (no model): `{...spec, offset, limit}` in,
  `{hits, nextOffset}` out. `nextOffset` is null on the last page; there is no count probe, so a full page at the cap ends the list.
- `GET/PUT /v1/profile` (the person's free-text notes). The agent's profile is the built resume as text plus those notes; nothing is generated.
- `jobs-port.ts`: `rankedSpec` turns a spec into the ranked query. `search` and `searchPage` run the same query.
- `GET /v1/jobs` keeps the newest-first keyset feed (`searchJobs`), but `q` is now required (400 without it): the feed
  had no index, and no client calls it without text.
- Missing `OPENCODE_API_KEY` or `AI_MODEL_SMART`: 503 with a clear message. Daily token ceiling reached: 429 (see Cost controls).

## Ranked search (`rankedJobs`, `packages/db/src/queries.ts`)

One FTS5 MATCH, built by `ftsScope`: each title phrase is quoted word by word (AND, no prefix) and scoped to the `title` column,
the phrases are ORed; companies are scoped to `company` and ANDed; places are scoped to `location_text` and ANDed. Only letters
and digits survive quoting, so no FTS operator reaches the query.
- The best `RANK_CANDIDATES` (2000) FTS rows are read in a bounded subquery, ordered by `bm25(jobs_fts, 10, 2, 1)` (title x10,
  company x2, location x1), then ties by rowid. However broad the terms, no more rows are read from the index.
- Those candidates join to `jobs` and pass `visibleJobs` (open, canonical, fresh source).
- Rows collapse by company and title: one row per company and title, the best-ranked location, with `locations` = how many
  candidate postings share that company and title. A role open in ten cities is one hit with "10 locations".
- Paged by offset in rank order (rank has no keyset), capped at 300 in total.
- With `remote`, the work mode is ORed with the places: a remote job anywhere, or a job whose location matches. Remote is not
  an AND filter. Remote alone is a work-mode filter on the candidates.
- Saved searches (`apps/api/src/searches.ts`) count the new roles with `countPostedSince`: postings posted after the search was
  last run, among the same capped candidates, at most `NEW_WINDOW` (30). A broad search costs no more here than on the list.

Not filtered: country, department, employment type. Their coverage is NULL for many postings, so filtering on them drops good jobs.

## Web (`apps/web`)

- `/`: `Assistant` island (`client:only`): `useChat<JobAgentMessage>` over `DefaultChatTransport('/api/chat')`; the conversation is kept in
  `sessionStorage`. Data fetching is TanStack Query (`queries.ts`): `useSearchPage` runs `currentSearch(messages)` through `/api/search` at an
  offset and keeps the previous page on screen while the next loads (the list never blanks); `useJob` loads a posting once per visit.
- Layout is CSS only: a `data-detail` / `data-tab` attribute on the container switches three columns (chat | results | posting) and flex
  transitions animate it. One tree serves desktop and mobile (Tailwind `lg:` / `max-lg:` variants). Opening a job tucks the chat into a bubble
  and slides the list left (400px) so you can click another job while you read; the bubble or Esc brings the chat back.
- Pieces: `Assistant` (state and layout), `ChatPanel`/`Messages`/`Composer`, `JobList` (+ `JobRow`, which shows "N locations"), `JobPage`,
  `queries.ts`, `hooks.ts`. `lib/assistant.ts` derives everything beside the chat from the messages: `currentSearch`, `notesById`, `activitiesOf`.
- "About you" sheet in the chat: the notes the resume leaves out (roles, pay, places, deal-breakers). The resume has its own page. Bookmarks stay in `localStorage` (`tallo:saved-roles`).
- A posting shows the assistant's note (if any), the full description, facts, and the other locations of the same posting.
- Tests: `Assistant.test.tsx` (jsdom) mounts the real tree with a finished conversation (list, open and switch postings, note, bubble, Esc,
  mobile); `Assistant.stream.test.tsx` replays a recorded production turn (`fixtures/turn.sse`) through the real `useChat`.

## Evaluation

The search design was measured on prod with a set of 30 requests (title, place and company asks) against hand-written truth
sets. The winning design is the one implemented here: one ranked, collapsed OR query over title phrases, places ANDed with the titles,
server-side place expansion, a 20-hit model view.
- Precision at 40 (P@40): 0.67 for the previous per-phrase, newest-first design; 0.84 for this one.
- Rows read: about 4x lower than the previous design (the bounded candidate set replaces reading every match and sorting it by time).

Rows read on prod for five of the experiment's queries (`cf d1 query`, SELECT only, 2026-10-26). The probe SQL was written by
hand with the same shape as `rankedJobs` (same MATCH, bounded candidates, visibility, collapse); it is not drizzle's output. The
query plan shows the MATCH on the FTS index, the candidate sort, and primary-key joins. These are single runs during a full sync:

| Query                                     | Places             | Rows read |
| ----------------------------------------- | ------------------ | --------- |
| backend engineer jobs                     | none               | 12,401    |
| frontend engineer in NYC                  | NYC metro          | 345       |
| machine learning engineer in the Bay Area | Bay Area metro     | 8,527     |
| registered nurse in Houston               | Houston metro      | 239       |
| data scientist, remote                    | remote (work mode) | 7,583     |

The reads are the FTS index rows plus the candidate joins. A title with many postings costs up to the 2000-candidate bound; a
place that narrows the MATCH (NYC, Houston) costs far less.

## Cost controls

Every AI call goes through one gate (`openGate`, `apps/api/src/assistant.ts`) and the AI SDK's own middleware; nothing else is custom.
- **Ceilings per request.** Chat: at most `MAX_STEPS` (14) model calls, `STEP_OUTPUT_TOKENS` (2000) output per call, `MAX_READS` reads, and once
  a message has spent `TURN_INPUT_TOKENS` (160k, read from provider usage) the tools are removed so the model can only answer. One call's
  input is held under `STEP_INPUT_TOKENS` (24k estimated) by replacing the oldest search results with a marker, and the model sees only the
  last 40 messages (`recentTurns`); the browser still holds the whole chat. Resume calls set `maxOutputTokens` explicitly.
- **Clipping is marked.** `clip` (`@tallo/ai`) keeps the first 40% and last 60% of a long description and inserts
  `[... N characters left out here ...]`, so the model never reads a gap as the whole text. Reads are clipped at 20k characters (about 5k
  tokens), resume tailor/fit/prep/letter at 12k. The old silent `slice` is gone. The tail is kept because pay and requirements sit there.
- **Prompt caching.** The chat's system message (tools, instructions, profile) and the newest message carry Anthropic cache markers, so each
  step and each turn reads the earlier prefix from the cache. Providers that do not support it ignore the marker (`go` openai-compatible
  models do; `go-anthropic` and `anthropic` honour it). Whether it works shows in the log as `cached` (below).
- **Usage log.** One line per request: `{"event":"ai.usage","feature":"chat|resume.fit|...","model","steps","input","cached","cacheWrite","output"}`.
  Read it with `wrangler tail` or Workers Logs (observability is already on).
- **Daily budget.** `AI_DAILY_TOKEN_LIMIT` (input plus output, per UTC day, default 2,000,000, a bad value is a 503). Over it, AI routes answer
  429 with `Retry-After` until 00:00 UTC. The count is kept in memory per isolate unless a KV namespace is bound as `AI_SPEND`, which makes it
  shared and survives restarts. KV read-modify-write is not atomic: two requests ending together can lose one update, which is fine for a
  guard for one user. Tokens are counted when a request ends, so one request can overshoot by its own size.
- **Cheap routing.** Roles are `fast` and `smart`. Resume import and fit-check (extraction and structured comparison) use `fast`; chat,
  tailoring, editing, cover letters and interview prep use `smart`. `fast` falls back to `smart` until `AI_MODEL_FAST` is set, so nothing
  changes until you opt in. Re-test a candidate with the structured-output list above before choosing it.

To enable (nothing here is created by the code or deployed):

```jsonc
// apps/api/wrangler.jsonc, optional
"kv_namespaces": [{ "binding": "AI_SPEND", "id": "<id from: cf kv namespace create tallo-ai-spend>" }],
"vars": { "AI_MODEL_SMART": "go-anthropic:claude-haiku-5-5", "AI_MODEL_FAST": "go:<cheap structured-output model>", "AI_DAILY_TOKEN_LIMIT": "2000000" }
```

## Models on OpenCode Go (measured 2026-10-26)

Default: `go-anthropic:claude-haiku-5-5` (reliable tool calls, 6-12 s per turn). With `supportsStructuredOutputs`, `deepseek-v4.1-flash`,
`qwen3.8-flash`, `kimi-k3`, `mimo-v2.6-flash` honour `json_schema`; `glm-5.x` and `minimax-m3.1-flash` answer in prose; `deepseek-v4-pro`
rejects the format. Re-test a model before using it. Go is for coding-agent traffic and single-member workspaces: fine for private use,
revisit before public use.

## Open

- Relevance is by title (bm25 over title, company and location text). Descriptions are not indexed, so a role whose title shares no
  word with the phrases the model tries is missed (vector recall, issue #16, would sit behind the search).
- Ranking weights (10, 2, 1) are a first choice, not tuned on the full experiment set.
- The remote filter applies after the candidate cut: a broad title with many onsite postings may hide remote ones beyond the 2000 candidates.
- Collapse groups by company slug and lowercase title; the location count is a lower bound (only candidates are counted).
