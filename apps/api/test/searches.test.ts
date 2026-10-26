import type { SavedSearch } from "@tallo/contracts";
import { saveSearch } from "@tallo/db";
import { describe, expect, it } from "vitest";
import { auth, build, seedJob } from "./support.ts";

type App = ReturnType<typeof build>["app"];
const send = (app: App, path: string, method: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: auth,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const backend = { name: "Backend", spec: { queries: ["backend engineer"] } };

describe("saved search routes", () => {
  it("counts roles posted since the search was last run, and clears on seen", async () => {
    const { app, blobs, db } = build(null);
    await seedJob(db, blobs);
    // The seeded job is posted at 1000; this search was last run at 500, so the job is new.
    await saveSearch(db, backend, "me", 500);

    const before = (await (await send(app, "/v1/searches", "GET")).json()) as SavedSearch[];
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ name: "Backend", newCount: 1, newCapped: false });

    const seen = await send(app, `/v1/searches/${before[0]?.id}/seen`, "POST");
    expect(seen.status).toBe(200);
    expect(await seen.json()).toMatchObject({ id: before[0]?.id, newCount: 0 });

    const after = (await (await send(app, "/v1/searches", "GET")).json()) as SavedSearch[];
    expect(after[0]).toMatchObject({ newCount: 0, newCapped: false });
    expect((await send(app, "/v1/searches", "GET")).headers.get("cache-control")).toBe(
      "private, no-store",
    );
  });

  it("saves a search once: the same spec again returns the same row", async () => {
    const { app, blobs, db } = build(null);
    await seedJob(db, blobs);

    const first = (await (await send(app, "/v1/searches", "POST", backend)).json()) as SavedSearch;
    expect(first).toMatchObject({ name: "Backend", newCount: 0, newCapped: false });

    const again = await send(app, "/v1/searches", "POST", {
      name: "Renamed",
      spec: { queries: ["  Backend Engineer"] },
    });
    expect(await again.json()).toMatchObject({ id: first.id, name: "Backend" });
    expect(await (await send(app, "/v1/searches", "GET")).json()).toHaveLength(1);
  });

  it("answers 409 at the cap", async () => {
    const { app, db } = build(null);
    for (let i = 0; i < 20; i++) {
      await saveSearch(db, { name: `s${i}`, spec: { queries: [`title ${i}`] } }, "me", i);
    }
    const response = await send(app, "/v1/searches", "POST", backend);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "You can keep up to 20 searches. Remove one first.",
    });
  });

  it("answers 404 for an unknown search", async () => {
    const { app } = build(null);
    const response = await send(app, "/v1/searches/99/seen", "POST");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  it("deletes a search", async () => {
    const { app, blobs, db } = build(null);
    await seedJob(db, blobs);
    const saved = (await (await send(app, "/v1/searches", "POST", backend)).json()) as SavedSearch;
    expect((await send(app, `/v1/searches/${saved.id}`, "DELETE")).status).toBe(204);
    expect(await (await send(app, "/v1/searches", "GET")).json()).toEqual([]);
  });

  it("refuses requests without a token", async () => {
    const { app } = build(null);
    expect((await app.request("/v1/searches")).status).toBe(401);
  });

  it("rejects an invalid body", async () => {
    const { app } = build(null);
    expect(
      (await send(app, "/v1/searches", "POST", { name: "", spec: { queries: [] } })).status,
    ).toBe(400);
  });
});
