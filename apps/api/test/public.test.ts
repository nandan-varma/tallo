import { NEGATIVE_CACHE_CONTROL } from "@tallo/contracts";
import { jdKey, schema } from "@tallo/db";
import { d1Like } from "@tallo/db/testing";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { type D1Like, meterD1 } from "../src/meter.ts";
import { type Blobs, type Db, SOURCE, seed, setup } from "./fixtures.ts";
import { INGEST } from "./support.ts";

const app = (db: Db, blobs: Blobs) => createApp({ db, blobs, ingestToken: INGEST });

const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

describe("GET /v1/jobs/:id", () => {
  it("serves the facts, the other locations and the first chunk of the description", async () => {
    const { db, blobs } = setup();
    const description = "x".repeat(9000);
    const id = await seed(db, blobs, { postingId: "1", title: "Data Engineer", description });
    await db
      .update(schema.jobs)
      .set({ applyUrl: "https://boards.example.com/apply/1", employmentType: "full_time" })
      .where(eq(schema.jobs.id, id));

    const response = await app(db, blobs).request(`/v1/jobs/${id}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=3600");
    const body = await json(response);
    expect(body).toMatchObject({
      id: String(id),
      title: "Data Engineer",
      company: "Acme",
      applyUrl: "https://boards.example.com/apply/1",
      employmentType: "full_time",
      descriptionChars: 9000,
      description: "x".repeat(4000),
      descriptionNext: 4000,
      variants: [
        expect.objectContaining({ id: String(id), applyUrl: "https://boards.example.com/apply/1" }),
      ],
    });
    expect(Object.keys(body)).not.toEqual(
      expect.arrayContaining(["jdHash", "facts", "sourceHash"]),
    );
  });

  it("answers 400 for a malformed id and 404 with a hint for an unknown one", async () => {
    const { db, blobs } = setup();
    const server = app(db, blobs);
    for (const id of ["abc", "0", "-1", "1.5"]) {
      const response = await server.request(`/v1/jobs/${id}`);
      expect(response.status, id).toBe(400);
      expect(await json(response)).toMatchObject({ error: { code: "invalid_parameter" } });
    }
    const missing = await server.request("/v1/jobs/999");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe(NEGATIVE_CACHE_CONTROL.unknown);
    const body = (await json(missing)) as { error: { code: string; hint: string } };
    expect(body.error.code).toBe("unknown");
    expect(body.error.hint).toContain("/v1/search");
  });

  it("hides a closed posting and one whose source stopped listing, as search does", async () => {
    const { db, blobs } = setup();
    const closed = await seed(db, blobs, { postingId: "1", title: "Data Engineer", closed: true });
    const open = await seed(db, blobs, {
      postingId: "2",
      title: "Data Engineer",
      company: "Other",
    });
    const server = app(db, blobs);
    const closedResponse = await server.request(`/v1/jobs/${closed}`);
    expect(closedResponse.status).toBe(410);
    expect(closedResponse.headers.get("cache-control")).toBe(NEGATIVE_CACHE_CONTROL.closed);
    expect(((await json(closedResponse)) as { error: { code: string } }).error.code).toBe("closed");
    expect((await server.request(`/v1/jobs/${open}`)).status).toBe(200);

    await db.update(schema.sources).set({ lastListedAt: 1 }).where(eq(schema.sources.id, SOURCE));
    const hidden = await server.request(`/v1/jobs/${open}`);
    expect(hidden.status).toBe(404);
    expect(hidden.headers.get("cache-control")).toBe(NEGATIVE_CACHE_CONTROL.source_hidden);
    expect(((await json(hidden)) as { error: { code: string } }).error.code).toBe("source_hidden");
  });

  it("publishes the negative TTLs the edge cache relies on", () => {
    // A minute for states that can change back (a closed posting, a hidden source), an hour for an id with no row.
    expect(NEGATIVE_CACHE_CONTROL).toEqual({
      closed: "public, max-age=60, s-maxage=60",
      source_hidden: "public, max-age=60, s-maxage=60",
      unknown: "public, max-age=3600, s-maxage=3600",
    });
  });

  it("gives the description route the same negative TTLs as the job page", async () => {
    const { db, blobs } = setup();
    const closed = await seed(db, blobs, { postingId: "1", title: "Data Engineer", closed: true });
    const server = app(db, blobs);
    const closedAnswer = await server.request(`/v1/jobs/${closed}/description`);
    expect(closedAnswer.status).toBe(410);
    expect(closedAnswer.headers.get("cache-control")).toBe(NEGATIVE_CACHE_CONTROL.closed);
    const unknownAnswer = await server.request("/v1/jobs/99999/description");
    expect(unknownAnswer.status).toBe(404);
    expect(unknownAnswer.headers.get("cache-control")).toBe(NEGATIVE_CACHE_CONTROL.unknown);
  });

  it("keeps parameter errors uncached", async () => {
    const { db, blobs } = setup();
    const id = await seed(db, blobs, { postingId: "1", title: "Data Engineer" });
    const server = app(db, blobs);
    expect((await server.request("/v1/jobs/abc")).headers.get("cache-control")).toBe("no-store");
    expect(
      (await server.request(`/v1/jobs/${id}/description?offset=-1`)).headers.get("cache-control"),
    ).toBe("no-store");
  });

  it("reports what each public read cost the database in the cost header", async () => {
    const { db, blobs } = setup();
    const id = await seed(db, blobs, { postingId: "1", title: "Data Engineer" });
    // The same drizzle-over-D1 path production takes, over the test database.
    const metered = createApp({
      // The binding's Workers type is not loaded in the test config; the structural D1Like is what the meter needs.
      db: drizzle(meterD1(d1Like(db) as D1Like) as never, { schema }) as unknown as Db,
      blobs,
      ingestToken: INGEST,
    });
    for (const path of ["/v1/search?title=data+engineer", `/v1/jobs/${id}`]) {
      const response = await metered.request(path);
      const cost = JSON.parse(response.headers.get("x-tallo-cost") ?? "null");
      expect(cost, path).toMatchObject({
        statements: expect.any(Number),
        rows_returned: expect.any(Number),
      });
      expect(cost.statements, path).toBeGreaterThan(0);
      expect(cost.rows_returned, path).toBeGreaterThan(0);
      // Drizzle's select path reads through D1's raw(), which carries no meta: rows_read stays unknown, not zero.
      expect(cost.rows_read, path).toBeNull();
    }
  });

  it("sends no cost header from routes that are not public reads", async () => {
    const { db, blobs } = setup();
    const response = await app(db, blobs).request("/health");
    expect(response.headers.get("x-tallo-cost")).toBeNull();
  });

  it("answers a null description, not a guess, when its blob is gone", async () => {
    const { db, blobs } = setup();
    const id = await seed(db, blobs, { postingId: "1", title: "Data Engineer" });
    const [row] = await db
      .select({ jdHash: schema.jobs.jdHash })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, id));
    await blobs.delete(jdKey(row!.jdHash));

    const body = await json(await app(db, blobs).request(`/v1/jobs/${id}`));
    expect(body).toMatchObject({
      description: null,
      descriptionChars: null,
      descriptionNext: null,
    });
  });
});

describe("GET /v1/jobs/:id/description", () => {
  it("reads the description in chunks that join back to the whole text", async () => {
    const { db, blobs } = setup();
    const text = Array.from({ length: 9999 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(
      "",
    );
    const id = await seed(db, blobs, { postingId: "1", title: "Data Engineer", description: text });
    const server = app(db, blobs);

    let offset: number | null = 0;
    let joined = "";
    for (let guard = 0; offset !== null && guard < 10; guard++) {
      const body = await json(
        await server.request(`/v1/jobs/${id}/description?offset=${offset}&limit=3000`),
      );
      joined += body.description;
      expect(body.descriptionChars).toBe(9999);
      offset = body.descriptionNext as number | null;
    }
    expect(joined).toBe(text);
  });

  it("validates the chunk bounds with hints, and answers an empty chunk at the very end", async () => {
    const { db, blobs } = setup();
    const id = await seed(db, blobs, {
      postingId: "1",
      title: "Data Engineer",
      description: "abcdef",
    });
    const server = app(db, blobs);

    const tooBig = await server.request(`/v1/jobs/${id}/description?limit=8001`);
    expect(tooBig.status).toBe(400);
    expect(((await json(tooBig)) as { error: { hint: string } }).error.hint).toContain("8000");
    expect((await server.request(`/v1/jobs/${id}/description?limit=0`)).status).toBe(400);
    expect((await server.request(`/v1/jobs/${id}/description?offset=-1`)).status).toBe(400);

    const past = await server.request(`/v1/jobs/${id}/description?offset=7`);
    expect(past.status).toBe(400);
    expect(((await json(past)) as { error: { message: string } }).error.message).toContain(
      "6 characters",
    );

    const end = await json(await server.request(`/v1/jobs/${id}/description?offset=6`));
    expect(end).toMatchObject({ description: "", descriptionNext: null, descriptionChars: 6 });
  });

  it("refuses a parameter it does not know, and a closed posting", async () => {
    const { db, blobs } = setup();
    const id = await seed(db, blobs, { postingId: "1", title: "Data Engineer" });
    const closed = await seed(db, blobs, { postingId: "2", title: "Data Engineer", closed: true });
    const server = app(db, blobs);

    const typo = await server.request(`/v1/jobs/${id}/description?q=engineer`);
    expect(((await json(typo)) as { error: { code: string } }).error.code).toBe(
      "unknown_parameter",
    );
    expect((await server.request(`/v1/jobs/${closed}/description`)).status).toBe(410);
  });
});

describe("public CORS", () => {
  it("answers preflight and marks every public answer", async () => {
    const { db, blobs } = setup();
    const server = app(db, blobs);
    const preflight = await server.request("/v1/search", { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("GET");
    const answer = await server.request("/v1/search?title=data+engineer");
    expect(answer.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("removed personal routes", () => {
  it("answers 404 for every route the pivot removed", async () => {
    const { db, blobs } = setup();
    const server = app(db, blobs);
    for (const [method, path] of [
      ["GET", "/v1/applications"],
      ["GET", "/v1/searches"],
      ["GET", "/v1/resume"],
      ["GET", "/v1/profile"],
      ["POST", "/v1/ai/chat"],
    ] as const) {
      const response = await server.request(path, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });
});

describe("the public reads on the API's own custom domain", () => {
  const BLOCKED = "tallo-api.nandan.fyi";
  const blocked = (db: Db, blobs: Blobs) =>
    createApp({ db, blobs, ingestToken: INGEST, readsBlockedHost: BLOCKED });

  it("answers 404 for the three public reads on the blocked host", async () => {
    const { db, blobs } = setup();
    const id = await seed(db, blobs, { postingId: "1", title: "Data Engineer" });
    const server = blocked(db, blobs);
    for (const path of [
      "/v1/search?title=data+engineer",
      `/v1/jobs/${id}`,
      `/v1/jobs/${id}/description`,
    ]) {
      const response = await server.request(`https://${BLOCKED}${path}`);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("cache-control"), path).toBe("no-store");
      expect(((await json(response)) as { error: { code: string } }).error.code, path).toBe(
        "not_found",
      );
    }
  });

  it("still serves the reads on the service-binding host the web uses, and on other hosts", async () => {
    const { db, blobs } = setup();
    const id = await seed(db, blobs, { postingId: "1", title: "Data Engineer" });
    const server = blocked(db, blobs);
    expect(
      (await server.request(`https://api.internal/v1/search?title=data+engineer`)).status,
    ).toBe(200);
    expect((await server.request(`https://api.internal/v1/jobs/${id}`)).status).toBe(200);
    // Exact host match only: a lookalike host is not the blocked one.
    expect(
      (await server.request(`https://${BLOCKED}.example.com/v1/search?title=data+engineer`)).status,
    ).toBe(200);
  });

  it("keeps the ingest and admin routes reachable on the blocked host", async () => {
    const { db, blobs } = setup();
    const server = blocked(db, blobs);
    const status = await server.request(`https://${BLOCKED}/v1/sources/status`, {
      headers: { authorization: `Bearer ${INGEST}` },
    });
    expect(status.status).toBe(200);
    expect((await server.request(`https://${BLOCKED}/v1/sources/status`)).status).toBe(401);
    const health = await server.request(`https://${BLOCKED}/health`);
    expect(health.status).toBe(200);
  });

  it("allows the reads everywhere when the var is unset (tests and local development)", async () => {
    const { db, blobs } = setup();
    await seed(db, blobs, { postingId: "1", title: "Data Engineer" });
    const unset = createApp({ db, blobs, ingestToken: INGEST });
    expect((await unset.request(`https://${BLOCKED}/v1/search?title=data+engineer`)).status).toBe(
      200,
    );
    const empty = createApp({ db, blobs, ingestToken: INGEST, readsBlockedHost: "" });
    expect((await empty.request(`https://${BLOCKED}/v1/search?title=data+engineer`)).status).toBe(
      200,
    );
  });
});
