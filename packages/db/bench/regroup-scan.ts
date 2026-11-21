/**
 * Optional local benchmark for the hourly regroup cursor. It captures the SQL that
 * `regroupCandidates` actually builds, binds the cursor parameters, and runs it against a real
 * SQLite file with `.stats vmstep`. Not part of `pnpm check`: it needs the `sqlite3` CLI.
 *
 * `node packages/db/bench/regroup-scan.ts`
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { regroupCandidates } from "../src/ingest.ts";
import * as schema from "../src/schema.ts";

const MIGRATIONS = new URL("../drizzle/", import.meta.url);
const ROWS = 10_000;
const bin = process.env.SQLITE3 ?? "sqlite3";

try {
  execFileSync(bin, ["--version"], { stdio: "ignore" });
} catch {
  console.log(`sqlite3 CLI not found (${bin}); skipping the regroup benchmark.`);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "tallo-regroup-bench-"));
const file = join(dir, "bench.db");
try {
  const sqlite = new DatabaseSync(file);
  for (const migration of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    for (const statement of readFileSync(new URL(migration, MIGRATIONS), "utf8").split(
      "--> statement-breakpoint",
    )) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
  sqlite.exec(`
    INSERT INTO sources (id, platform, key, company, company_slug, params, last_listed_at)
    VALUES ${[0, 1, 2, 3, 4]
      .map((n) => `('s${n}', 'lever', 's${n}', 'Acme', 'acme', '{}', -1209000)`)
      .join(", ")};
    INSERT INTO jobs (
      source_id, posting_id, company, company_slug, title, excerpt, jd_hash, jd_bytes,
      source_hash, facts, sort_at, first_seen_at, updated_at, dedupe_key, dup_of
    )
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS})
    SELECT 's' || (i % 5), 'p' || i, 'Acme', 'acme', 'Engineer ' || i, '', 'h' || i, 1,
           's' || i, '{}', 1, 1, 1, 'k' || i, CASE WHEN i > 1 THEN i - 1 END
    FROM n;
  `);
  sqlite.close();

  const captured: { sql: string; params: unknown[] }[] = [];
  const proxy = drizzle(
    async (sql, params) => {
      captured.push({ sql, params });
      return { rows: [] };
    },
    { schema },
  );
  const cursor = (phase: "updated" | "duplicates" | "stale") => ({
    at: 1000,
    since: 1,
    phase,
    updatedAt: 1,
    id: phase === "stale" ? 0 : 9000,
    duplicateId: 50,
    source: phase === "stale" ? "s1" : "",
    posting: phase === "stale" ? "p5" : "",
  });
  const queries: { phase: string; sql: string; params: unknown[] }[] = [];
  for (const phase of ["updated", "duplicates", "stale"] as const) {
    captured.length = 0;
    await regroupCandidates(proxy as never, cursor(phase) as never, 2);
    for (const query of captured) queries.push({ phase, ...query });
  }

  const bind = (sql: string, params: unknown[]) => {
    const quote = (value: unknown) =>
      typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
    let index = 0;
    return sql.replaceAll("?", () => quote(params[index++]));
  };
  const run = (sql: string, args: string[] = []) =>
    execFileSync(bin, [...args, file, sql], { encoding: "utf8" }).trim();
  const vmSteps = (sql: string) => {
    const out = run(sql, ["-cmd", ".stats vmstep"]);
    return Number(/VM-steps: (\d+)/.exec(out)?.[1] ?? -1);
  };
  const plan = (sql: string) =>
    run(`EXPLAIN QUERY PLAN ${sql}`)
      .split("\n")
      .map((line) => line.replace(/^QUERY PLAN\s*/, ""))
      .join(" | ");

  const oldTuple =
    "SELECT dedupe_key FROM jobs WHERE updated_at >= 1 AND updated_at <= 1000 " +
    "AND (updated_at, id) > (1, 9000) ORDER BY updated_at, id LIMIT 2";
  const updated = queries.find((q) => q.phase === "updated");
  if (!updated) throw new Error("no updated-phase query captured");
  const tie = queries.find((q) => q.phase === "updated" && q.sql.includes('"id" > ?'));
  if (!tie) throw new Error("no updated-phase tie query captured");

  console.log(`regroup scan benchmark: ${ROWS} jobs, cursor (updated_at=1, id=9000)`);
  console.log(`old row-value cursor: ${vmSteps(oldTuple)} VM steps`);
  console.log(`new equality/tie seek: ${vmSteps(bind(tie.sql, tie.params))} VM steps\n`);

  let bad = 0;
  for (const query of queries) {
    const sql = bind(query.sql, query.params);
    const detail = plan(sql);
    if (/\bSCAN jobs\b(?! USING)/.test(detail) || detail.includes("TEMP B-TREE")) bad++;
    console.log(`[${query.phase}] ${vmSteps(sql)} VM steps`);
    console.log(`  ${detail}`);
  }
  if (bad > 0) {
    console.error(`\n${bad} captured query plan(s) scan jobs or sort without an index.`);
    process.exitCode = 1;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
