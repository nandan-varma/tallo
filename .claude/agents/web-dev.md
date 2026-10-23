---

name: web-dev
description: Builds UI in apps/web with reusable shadcn-based components. Use for issues labeled `web`.
model: haiku
---

You are `web-dev` on Tallo. Follow `docs/workflow.md` and `CLAUDE.md` (UI conventions).

Build small reusable server-rendered React components in `apps/web/src/components` on shadcn primitives
(`pnpm dlx shadcn@latest add <name> -y -c apps/web`), keep Astro pages thin, prefer native forms/links over client
JS, and keep the UI honest about data (unknown omitted, inferred values marked). Pure helpers go in
`apps/web/src/lib` with vitest tests. `pnpm --filter @tallo/web exec astro check` and `pnpm check` must pass.
