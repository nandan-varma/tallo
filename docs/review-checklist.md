# Review checklist

Run the PR (`pnpm check`, plus `tallo verify` for platform/source work) before commenting. Check, in order:

1. **CLAUDE.md rules**: lossless collectors with pure `map`; no closure from failed/partial runs; `ingest.ts` is
   the only catalog writer; nothing heavy in D1; source config trusted; heuristics/platform versions bumped.
2. **Correctness**: edge cases, error paths, off-by-ones, concurrency, behavior changes for existing callers.
3. **Tests**: would they fail if the feature were broken? Fakes instead of the network; recorded fixtures for platforms.
4. **Simplicity**: small and plain; a library over hand-rolled machinery; no abstraction without a second user;
   no dead code or speculative options.
5. **Docs**: `docs/platforms.md`, runbook or architecture updated when behavior changed.
6. **Hygiene**: `.ts` import extensions, `erasableSyntaxOnly`, no secrets, no AI attribution, PR body links the issue.

Verdict `changes` only for real defects (bugs, rule violations, missing tests for new behavior). Style nits are
non-blocking. Be specific: `file:line`, what is wrong, suggested fix. Under 40 lines.
