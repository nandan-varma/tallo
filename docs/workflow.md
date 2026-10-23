# Workflow: stateless, GitHub-native

GitHub is the only state. Agents are stateless: a fresh agent can pick up any issue or PR by reading
this file, its role file (`.claude/agents/<role>.md`), the issue and its comments. Nothing lives in an
agent's memory or in chat. Every handoff is a comment; every status is a label.

## Labels

| Kind     | Labels                                                                                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Area     | `platform` `sources` `search` `web` `infra` `quality` `docs` `enrichment`                                                                                                        |
| Priority | `p1` (now) `p2` (next) `p3` (later)                                                                                                                                              |
| Status   | `status:ready` → `status:in-progress` → `status:in-review` → (`status:changes-requested` ↔ `status:in-review`) → `status:approved` → merged/closed. Side exit: `status:blocked`. |

Exactly one `status:*` label on an open issue or PR. Closed means done.

## Roles

Role files in `.claude/agents/`: `platform-dev`, `sources-scout`, `web-dev`, `quality-dev`, `reviewer`.
Workers (haiku) implement one issue. The main agent triages, merges, owns architecture and deploys.
A role is a hat, not a person: the same prompt can be run any number of times.

## Lifecycle

1. **Pick** an issue in your area: `gh issue list --label status:ready --label <area> --label p1` (then p2).
   Read the issue and all comments (`gh issue view N --comments`).
2. **Claim**: `gh issue edit N --add-label status:in-progress --remove-label status:ready`, then comment
   `Claimed by <role>. Branch: feat/<slug>.`
3. **Work** in your own worktree, never in the main clone:

   ```
   git -C ~/dev/tallo fetch origin
   git -C ~/dev/tallo worktree add ~/dev/tallo-wt/<slug> -b feat/<slug> origin/main
   cd ~/dev/tallo-wt/<slug> && pnpm install --frozen-lockfile
   ```

   Small commits, imperative messages, no AI attribution. `pnpm check` must pass.
4. **Open the PR**: `gh pr create --base main` with the PR template, `Closes #N`, label `status:in-review`
   (copy the area label). Comment on the issue: `PR opened: #P` plus a two-line summary. Relabel the issue
   `status:in-review`.
5. **Review** (a different agent than the author): `gh pr list --label status:in-review`. Check out the PR in a
   worktree, run the checks, review against `docs/review-checklist.md`, post one review with `gh pr review N
   --comment` in the format below, then relabel the PR `status:approved` or `status:changes-requested`.
6. **Address feedback** (any worker in the author's role): `gh pr list --label status:changes-requested`.
   Read the review, fix on the PR branch, push, comment `Addressed:` with one line per review item (fixed /
   disagree + why), relabel `status:in-review`.
7. **Merge**: the main agent squash-merges `status:approved` PRs with green CI, deletes the branch, closes the
   issue, updates `docs/PROGRESS.md` if the change matters to the next session.
8. **Blocked**: comment the exact question or missing input, relabel `status:blocked`. The main agent or the
   user answers in a comment and relabels `status:ready`.

## Comment formats

Review (PR):
```
## Review
Verdict: approve | changes
Blocking:
- file:line — problem — suggested fix
Non-blocking:
- ...
Verified: <commands run and results>
```

Addressed (PR):
```
## Addressed
- <item>: fixed in <sha> | disagree: <reason>
```

Handoff (issue), when stopping before the PR is ready:
```
## Handoff
Done: ...
Next: ...
Gotchas: ...
```

## Guardrails for every worker

- Read `CLAUDE.md` rules first; they override convenience.
- Never run `tallo sync`, deploy, use Cloudflare, or read `apps/runner/.env` / `~/.config/tallo`; those are main-agent actions.
- Never merge. Never push to `main`. Never push to someone else's branch except when addressing review on your own PR.
- No secrets in commits, comments or logs. No AI attribution in commits, PRs, issues or comments.
- If the task needs an architecture change, stop and comment on the issue instead of making it.

## Resuming a session (any agent, including the main one)

```
cat CLAUDE.md docs/PROGRESS.md
gh issue list --state open --json number,title,labels
gh pr list --state open --json number,title,labels
```
