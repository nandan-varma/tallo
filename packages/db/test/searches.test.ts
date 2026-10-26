import { describe, expect, it } from "vitest";
import { listSearchRows, markSearchSeen, removeSearch, saveSearch } from "../src/searches.ts";
import { testDb } from "../src/testing.ts";

const spec = { queries: ["backend engineer"], locations: ["Seattle"] };

describe("saved searches", () => {
  it("creates a search seen when it was saved, newest first", async () => {
    const db = testDb();
    const first = await saveSearch(db, { name: "Backend", spec }, "me", 100);
    expect(first).toEqual({ id: 1, name: "Backend", spec, createdAt: 100, seenAt: 100 });

    await saveSearch(db, { name: "Platform", spec: { queries: ["platform engineer"] } }, "me", 200);
    expect((await listSearchRows(db)).map((row) => row.name)).toEqual(["Platform", "Backend"]);
  });

  it("returns the existing row for the same spec in another order or case", async () => {
    const db = testDb();
    const first = await saveSearch(
      db,
      {
        name: "Backend",
        spec: { queries: ["Backend Engineer", "platform engineer"], locations: ["Seattle", "WA"] },
      },
      "me",
      100,
    );
    const again = await saveSearch(
      db,
      {
        name: "Renamed",
        spec: {
          queries: [" platform engineer", "backend engineer "],
          locations: ["wa", "SEATTLE"],
        },
      },
      "me",
      500,
    );
    expect(again).toEqual(first);
    expect(await listSearchRows(db)).toHaveLength(1);
  });

  it("refuses a 21st search and still returns a duplicate at the cap", async () => {
    const db = testDb();
    for (let i = 0; i < 20; i++) {
      await saveSearch(db, { name: `s${i}`, spec: { queries: [`title ${i}`] } }, "me", i);
    }
    await expect(
      saveSearch(db, { name: "extra", spec: { queries: ["one more"] } }, "me", 99),
    ).rejects.toThrow("You can keep up to 20 searches. Remove one first.");
    expect(
      await saveSearch(db, { name: "again", spec: { queries: ["title 3"] } }, "me", 99),
    ).toMatchObject({
      name: "s3",
    });
  });

  it("marks a search seen and returns null for an unknown id", async () => {
    const db = testDb();
    const saved = await saveSearch(db, { name: "Backend", spec }, "me", 100);
    const seen = await markSearchSeen(db, saved.id, "me", 300);
    expect(seen).toEqual({ ...saved, seenAt: 300 });
    expect(await markSearchSeen(db, 99, "me", 400)).toBeNull();
  });

  it("removes one search", async () => {
    const db = testDb();
    const saved = await saveSearch(db, { name: "Backend", spec }, "me", 100);
    await removeSearch(db, saved.id, "me");
    expect(await listSearchRows(db, "me")).toEqual([]);
  });

  it("keeps users apart", async () => {
    const db = testDb();
    const mine = await saveSearch(db, { name: "Mine", spec }, "me", 100);
    await saveSearch(db, { name: "Yours", spec }, "you", 100);

    expect((await listSearchRows(db, "you")).map((row) => row.name)).toEqual(["Yours"]);
    expect(await markSearchSeen(db, mine.id, "you", 200)).toBeNull();
    await removeSearch(db, mine.id, "you");
    expect((await listSearchRows(db, "me")).map((row) => row.name)).toEqual(["Mine"]);
  });
});
