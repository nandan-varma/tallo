import { zValidator } from "@hono/zod-validator";
import { NEW_WINDOW, type SavedSearch, saveSearchSchema } from "@tallo/contracts";
import {
  type Db,
  listSearchRows,
  markSearchSeen,
  removeSearch,
  SearchLimitError,
  type SearchRow,
  saveSearch,
} from "@tallo/db";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { newCountSince } from "./jobs-port.ts";

/** Saved searches: personal data, so read-token only and never cached. */
export function searchRoutes({ db, read }: { db: Db; read: MiddlewareHandler }) {
  const routes = new Hono();
  const byId = zValidator("param", z.object({ id: z.coerce.number().int().positive() }));

  /**
   * A search with how many of its best matches were posted after it was last run. Counted over the same capped
   * candidates the search reads, so a broad search costs no more here than on the results list.
   */
  const withCount = async (row: SearchRow): Promise<SavedSearch> => {
    const newCount = await newCountSince(db, row.spec, row.seenAt, NEW_WINDOW);
    return { ...row, newCount, newCapped: newCount === NEW_WINDOW };
  };

  routes.get("/v1/searches", read, async (c) => {
    c.header("cache-control", "private, no-store");
    const rows = await listSearchRows(db);
    return c.json(await Promise.all(rows.map(withCount)));
  });

  routes.post("/v1/searches", read, zValidator("json", saveSearchSchema), async (c) => {
    c.header("cache-control", "private, no-store");
    try {
      return c.json(await withCount(await saveSearch(db, c.req.valid("json"))));
    } catch (error) {
      if (error instanceof SearchLimitError) return c.json({ error: error.message }, 409);
      throw error;
    }
  });

  routes.post("/v1/searches/:id/seen", read, byId, async (c) => {
    c.header("cache-control", "private, no-store");
    const row = await markSearchSeen(db, c.req.valid("param").id);
    if (!row) return c.json({ error: "Not found" }, 404);
    // Just marked seen: nothing posted after this moment yet.
    return c.json({ ...row, newCount: 0, newCapped: false } satisfies SavedSearch);
  });

  routes.delete("/v1/searches/:id", read, byId, async (c) => {
    await removeSearch(db, c.req.valid("param").id);
    return c.body(null, 204);
  });

  return routes;
}
