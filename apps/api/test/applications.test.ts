import type { Application } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { auth, build, seedJob } from "./support.ts";

type App = ReturnType<typeof build>["app"];
const send = (app: App, path: string, method: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: auth,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("application routes", () => {
  it("tracks, lists and removes a posting", async () => {
    const { app, blobs, db } = build(null);
    await seedJob(db, blobs);

    const put = await send(app, "/v1/applications/1", "PUT", { status: "applied", note: "Ana" });
    expect(put.status).toBe(200);
    const saved = (await put.json()) as Application;
    expect(saved).toMatchObject({
      jobId: 1,
      status: "applied",
      note: "Ana",
      title: "Senior Backend Engineer",
      company: "Acme",
      location: "Remote, US",
    });
    expect(saved.appliedAt).not.toBeNull();

    const list = (await (await send(app, "/v1/applications", "GET")).json()) as Application[];
    expect(list.map((item) => item.jobId)).toEqual([1]);
    expect((await send(app, "/v1/applications", "GET")).headers.get("cache-control")).toBe(
      "private, no-store",
    );

    expect((await send(app, "/v1/applications/1", "DELETE")).status).toBe(204);
    expect(await (await send(app, "/v1/applications", "GET")).json()).toEqual([]);
  });

  it("answers 404 for a posting that is not listed", async () => {
    const { app } = build(null);
    const response = await send(app, "/v1/applications/99", "PUT", { status: "saved" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "That posting is no longer listed." });
  });

  it("refuses requests without a token", async () => {
    const { app, blobs, db } = build(null);
    await seedJob(db, blobs);
    const response = await app.request("/v1/applications");
    expect(response.status).toBe(401);
  });

  it("rejects an invalid status", async () => {
    const { app, blobs, db } = build(null);
    await seedJob(db, blobs);
    expect((await send(app, "/v1/applications/1", "PUT", { status: "hired" })).status).toBe(400);
  });
});
