# Orchestration

The main agent (strongest model) owns architecture, integration, merging, deploys and secrets. Cheap workers
(Haiku) implement one issue each; a different worker reviews every PR. All coordination is stateless and lives in
GitHub issues, PRs, labels and comments: see `docs/workflow.md` for the lifecycle, label scheme and comment
formats, `.claude/agents/*.md` for role definitions and `docs/review-checklist.md` for reviews.

## Dispatching a worker (main agent)

A worker needs only its role and an issue number; give it nothing else:

> You are `<role>`. Read `.claude/agents/<role>.md`, `docs/workflow.md` and `CLAUDE.md`, then do issue #N.

Run several workers in parallel when their issues touch different files. Do not run two schema-changing issues
at once (migration numbers collide). Workers never merge, deploy, sync or touch Cloudflare.

## Main-agent duties each session

1. `gh issue list` / `gh pr list`: triage new issues (area, priority, `status:ready`).
2. Dispatch reviewers for `status:in-review` PRs and fixers for `status:changes-requested` ones.
3. Merge `status:approved` PRs with green CI; apply remote migrations and deploy when needed (`docs/runbook.md`).
4. Keep `docs/PROGRESS.md` current (done / in flight / next / blockers).
