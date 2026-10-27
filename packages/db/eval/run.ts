/**
 * The standing search-quality harness. Runs every case in `cases.ts` through the same ranked query the site uses
 * (`rankedJobs`, with the spec mapped by `rankedSpec` from apps/api) and prints a table; `--json` writes the report.
 *
 *   pnpm --filter @tallo/db eval                              in-memory fixture (CI; no network)
 *   pnpm --filter @tallo/db eval -- --prod --truth truth.json --json out.json
 *
 * `--prod` runs the queries against the production D1 with `cf d1 query` (SELECT only). It reports rows read and
 * latency. Pass `--truth` to keep the truth counts in a file: the first run writes it, later runs reuse it, so a
 * before/after comparison uses the same snapshot and the truth queries are not repeated.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { testDb } from "../src/testing.ts";
import * as schema from "../src/schema.ts";
import { EVAL_CASES } from "./cases.ts";
import { seedFixture } from "./fixture.ts";
import { type Meter, runEval, table, type TruthCache } from "./harness.ts";
import type { Db } from "../src/db.ts";

/** The production catalog (the id in apps/api/wrangler.jsonc). An identifier, not a secret. */
const PROD_DATABASE = "001b036c-2e15-45c8-9284-edb9d374b849";

const execFileAsync = promisify(execFile);

function args(argv: string[]) {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    prod: argv.includes("--prod"),
    json: value("--json"),
    truth: value("--truth"),
    database: process.env.TALLO_D1_DATABASE ?? PROD_DATABASE,
  };
}

/** A SQL literal for one bound parameter. Only what the query builder binds: text, numbers and null. */
function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** The SQL with each `?` replaced by its literal. The builder emits `?` only as a placeholder. */
export function inline(text: string, params: unknown[]): string {
  let i = 0;
  const out = text.replace(/\?/g, () => {
    if (i >= params.length) throw new Error("More placeholders than parameters");
    return literal(params[i++]);
  });
  if (i !== params.length) throw new Error("More parameters than placeholders");
  return out;
}

interface D1Result {
  results?: Record<string, unknown>[];
  meta?: { rows_read?: number };
}

/** Drizzle over `cf d1 query`: each query is one CLI call; rows come back in column order. */
function prodDb(database: string, meter: Meter): Db {
  return drizzle(
    async (text, params, method) => {
      const { stdout } = await execFileAsync(
        "cf",
        ["d1", "query", database, "--sql", inline(text, params)],
        { maxBuffer: 256 * 1024 * 1024 },
      );
      const [result] = JSON.parse(stdout) as [D1Result];
      meter.rowsRead += result?.meta?.rows_read ?? 0;
      const rows = (result?.results ?? []).map((row) => Object.values(row));
      if (method === "run") return { rows: [] };
      return { rows: method === "get" ? (rows[0] ?? []) : rows };
    },
    { schema },
  ) as unknown as Db;
}

async function main() {
  const options = args(process.argv.slice(2));
  const now = Math.floor(Date.now() / 1000);
  const meter: Meter = { rowsRead: 0 };
  let db: Db;
  let mode: string;
  if (options.prod) {
    mode = "prod";
    db = prodDb(options.database, meter);
  } else {
    mode = "fixture";
    db = testDb() as unknown as Db;
    await seedFixture(db, now);
  }

  const truths: TruthCache =
    options.truth && existsSync(options.truth)
      ? (JSON.parse(readFileSync(options.truth, "utf8")) as TruthCache)
      : {};
  const report = await runEval(db, EVAL_CASES, {
    mode,
    now,
    meter: options.prod ? meter : null,
    truths,
  });
  if (options.truth) writeFileSync(options.truth, `${JSON.stringify(truths, null, 2)}\n`);
  if (options.json) writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
  console.log(table(report));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
