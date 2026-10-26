import { gzip, sha256 } from "@tallo/catalog";
import { jdKey, memoryBlobs, saveProfile, schema } from "@tallo/db";
import { testDb } from "@tallo/db/testing";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";

const READ = "read-token";
const INGEST = "ingest-token";
const auth = { authorization: `Bearer ${READ}`, "content-type": "application/json" };

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

/** One model step as stream parts: either a tool call or text. */
type Step = { tool: { name: string; input: unknown } } | { text: string };
function streamStep(step: Step) {
  const parts =
    "tool" in step
      ? [
          {
            type: "tool-call",
            toolCallId: "t1",
            toolName: step.tool.name,
            input: JSON.stringify(step.tool.input),
          },
          { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
        ]
      : [
          { type: "text-start", id: "x" },
          { type: "text-delta", id: "x", delta: step.text },
          { type: "text-end", id: "x" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
        ];
  return {
    stream: simulateReadableStream({
      chunks: [{ type: "stream-start", warnings: [] }, ...parts] as never,
    }),
  };
}

type CallOptions = Parameters<MockLanguageModelV4["doGenerate"]>[0];

/** A scripted model; `prompts` collects everything it was shown. */
function scripted(steps: Step[]) {
  const prompts: string[] = [];
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options: CallOptions) => {
      prompts.push(JSON.stringify(options.prompt));
      return streamStep(steps[Math.min(n++, steps.length - 1)] as Step) as never;
    },
    doGenerate: async (options: CallOptions) => {
      prompts.push(JSON.stringify(options.prompt));
      return {
        content: [{ type: "text" as const, text: "# Summary\nBackend engineer." }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage,
        warnings: [],
      } as never;
    },
  });
  return { model, prompts };
}

async function seedJob(db: ReturnType<typeof testDb>, blobs: ReturnType<typeof memoryBlobs>) {
  const text = "Pay: $200,000.";
  const jdHash = await sha256(text);
  await blobs.put(jdKey(jdHash), await gzip(new TextEncoder().encode(text)));
  await db.insert(schema.sources).values({
    id: "greenhouse:acme",
    platform: "greenhouse",
    key: "acme",
    company: "Acme",
    companySlug: "acme",
    params: {},
    lastListedAt: Math.floor(Date.now() / 1000),
  });
  await db.insert(schema.jobs).values({
    sourceId: "greenhouse:acme",
    postingId: "1",
    company: "Acme",
    companySlug: "acme",
    title: "Senior Backend Engineer",
    classifierVersion: 1,
    excerpt: text,
    jdHash,
    jdBytes: text.length,
    sourceHash: "b".repeat(64),
    facts: {},
    sortAt: 1000,
    firstSeenAt: 1,
    updatedAt: 1,
    locationText: "Remote, US",
  });
}

function build(model: MockLanguageModelV4 | null) {
  const db = testDb();
  const blobs = memoryBlobs();
  const app = createApp({
    db,
    blobs,
    readToken: READ,
    ingestToken: INGEST,
    model: () => model,
  });
  return { app, db, blobs };
}

const userMessage = (text: string) => ({
  id: "u1",
  role: "user",
  parts: [{ type: "text", text }],
});
const chat = (app: ReturnType<typeof build>["app"], text: string, headers = auth) =>
  app.request("/v1/ai/chat", {
    method: "POST",
    headers,
    body: JSON.stringify({ messages: [userMessage(text)] }),
  });

describe("POST /v1/ai/chat", () => {
  it("needs a token", async () => {
    const { app } = build(scripted([{ text: "hi" }]).model);
    expect((await chat(app, "hi", { "content-type": "application/json" } as never)).status).toBe(
      401,
    );
  });

  it("answers 503 with a clear message when no model is configured", async () => {
    const { app } = build(null);
    const response = await chat(app, "hi");
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toMatch(/OPENCODE_API_KEY/);
  });

  it("validates the body", async () => {
    const { app } = build(scripted([{ text: "hi" }]).model);
    const response = await app.request("/v1/ai/chat", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ messages: [] }),
    });
    expect(response.status).toBe(400);
  });

  it("streams a turn: the agent searches the catalog, then answers", async () => {
    const { model } = scripted([
      { tool: { name: "search_jobs", input: { queries: ["backend engineer"] } } },
      { text: "Found one role." },
    ]);
    const { app, db, blobs } = build(model);
    await seedJob(db, blobs);

    const response = await chat(app, "backend roles");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toContain("tool-input-available");
    expect(body).toContain("tool-output-available");
    expect(body).toContain("Senior Backend Engineer");
    expect(body).toContain("Found one role.");
  });

  it("gives the agent the saved profile, and says so when there is none", async () => {
    const withProfile = scripted([{ text: "ok" }]);
    const a = build(withProfile.model);
    await saveProfile(a.db, { resume: "r", profile: "# Summary\nRustacean, 9 years." });
    await (await chat(a.app, "hi")).text();
    expect(withProfile.prompts[0]).toContain("Rustacean, 9 years.");

    const without = scripted([{ text: "ok" }]);
    const b = build(without.model);
    await (await chat(b.app, "hi")).text();
    expect(without.prompts[0]).toContain("No profile is saved yet");
  });

  it("leaks nothing when the model fails", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("secret upstream detail sk-123");
      },
    });
    const { app } = build(model);
    const body = await (await chat(app, "hi")).text();
    expect(body).not.toContain("sk-123");
    expect(body).toContain("The assistant hit an error");
  });
});

describe("profile routes", () => {
  it("is null until saved, then round-trips", async () => {
    const { app } = build(null);
    const empty = await app.request("/v1/profile", { headers: auth });
    expect(await empty.json()).toBeNull();

    const put = await app.request("/v1/profile", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ resume: "my resume", profile: "# Summary" }),
    });
    expect(put.status).toBe(200);
    const got = (await (await app.request("/v1/profile", { headers: auth })).json()) as {
      resume: string;
      profile: string;
    };
    expect(got).toMatchObject({ resume: "my resume", profile: "# Summary" });
  });

  it("rejects an oversized profile", async () => {
    const { app } = build(null);
    const response = await app.request("/v1/profile", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ resume: "r", profile: "x".repeat(30_001) }),
    });
    expect(response.status).toBe(400);
  });

  it("generates profile markdown from a resume without storing it", async () => {
    const { model, prompts } = scripted([{ text: "unused" }]);
    const { app } = build(model);
    const resume = "Senior backend engineer with eight years of TypeScript and Postgres.";

    const response = await app.request("/v1/profile/generate", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ resume }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ profile: "# Summary\nBackend engineer." });
    expect(prompts[0]).toContain("eight years of TypeScript");
    expect(await (await app.request("/v1/profile", { headers: auth })).json()).toBeNull();
  });

  it("asks for a real resume, and answers 503 without a model", async () => {
    const { app } = build(scripted([{ text: "x" }]).model);
    const short = await app.request("/v1/profile/generate", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ resume: "hi" }),
    });
    expect(short.status).toBe(400);

    const none = build(null).app;
    const response = await none.request("/v1/profile/generate", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ resume: "A".repeat(50) }),
    });
    expect(response.status).toBe(503);
  });
});
