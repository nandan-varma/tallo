# Orchestration: how work is run

The main agent (Fable/Opus-class) owns architecture and integration. Cheap Haiku subagents do bounded work.

## Loop

1. **Backlog = GitHub issues.** Labels: `platform`, `sources`, `search`, `web`, `infra`, `quality`, `docs`; priority
   `p1`/`p2`/`p3`. An issue states the goal, acceptance criteria, and files likely touched.
2. **One issue → one branch → one PR** (`feat/<slug>`), PR body links `Closes #n` and lists how it was verified
   (`pnpm check`, `tallo verify`, tests added).
3. **Workers** (haiku subagents, named by role, e.g. `platform-dev`, `sources-scout`, `reviewer-a`) implement a single
   issue each. They never change architecture rules in `CLAUDE.md`; if blocked by one they comment on the issue.
4. **Cross-review.** Every PR is reviewed by a _different_ worker than its author (reuse a named reviewer so it accumulates
   context across PRs). The reviewer checks the rules in `CLAUDE.md`, test quality, and leaves PR comments; the author
   fixes; the main agent merges (squash) when `pnpm check` passes.
5. **Main agent** triages new issues, resolves conflicts between workers, and updates `docs/PROGRESS.md`.

## Roles

| Role                    | Does                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------- |
| main                    | architecture, hard integrations, merging, infra/deploy, docs                       |
| platform-dev            | new platform folders from `docs/adding-a-platform.md`                              |
| sources-scout           | takes URL lists, adds `sources/*.json` entries via `tallo verify`, reports rejects |
| reviewer-a / reviewer-b | review PRs authored by anyone else; alternate so each sees different authors       |
| quality                 | tests, fixtures, lint, small refactors flagged by reviewers                        |

## Stopping and resuming

All state is in git and GitHub. To resume: read `CLAUDE.md`, `docs/PROGRESS.md`, then `gh issue list` and
`gh pr list`. Always leave `docs/PROGRESS.md` current (done / in flight / next / blockers) and commit it.
