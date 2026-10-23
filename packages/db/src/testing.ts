import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "./schema.ts";

const MIGRATIONS = new URL("../drizzle/", import.meta.url);

/** In-memory SQLite behind Drizzle's proxy driver, with every migration applied. Tests only. */
export function testDb() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    for (const statement of readFileSync(new URL(file, MIGRATIONS), "utf8").split(
      "--> statement-breakpoint",
    )) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
  const run = (sql: string, params: unknown[], method: string) => {
    const stmt = sqlite.prepare(sql);
    if (method === "run") {
      stmt.run(...(params as never[]));
      return { rows: [] };
    }
    stmt.setReturnArrays(true);
    const rows = stmt.all(...(params as never[])) as unknown as unknown[][];
    return { rows: method === "get" ? (rows[0] ?? []) : rows };
  };
  return drizzle(
    async (sql, params, method) => run(sql, params, method),
    async (queries) => {
      sqlite.exec("BEGIN");
      try {
        const out = queries.map((q) => run(q.sql, q.params, q.method));
        sqlite.exec("COMMIT");
        return out;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    { schema },
  );
}
