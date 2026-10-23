Closes #

## What and why

## How it was verified

- [ ] `pnpm check`
- [ ] Platform/source changes: `tallo verify <source>` output pasted or summarized
- [ ] Docs updated (`docs/platforms.md`, `docs/PROGRESS.md` if relevant)

## Rules check (see CLAUDE.md)

- [ ] Lossless collection, pure `map`, unknown stays NULL
- [ ] No closure from failed/partial runs
- [ ] No descriptions/raw payloads in D1; no secrets committed
