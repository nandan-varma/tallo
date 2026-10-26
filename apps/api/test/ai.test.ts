import { saveProfile } from "@tallo/db";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { auth, build, seedJob, usage } from "./support.ts";

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

describe("POST /v1/jobs/search", () => {
  it("pages the database's answer to a search spec, and validates the spec", async () => {
    const { app, db, blobs } = build(null);
    await seedJob(db, blobs);
    const post = (value: unknown) =>
      app.request("/v1/jobs/search", {
        method: "POST",
        headers: auth,
        body: JSON.stringify(value),
      });

    const page = await post({ queries: ["backend engineer"], limit: 5 });
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    const json = (await page.json()) as { hits: { title: string }[]; nextCursor: string | null };
    expect(json.hits.map((h) => h.title)).toEqual(["Senior Backend Engineer"]);
    expect(json.nextCursor).toBeNull();

    expect((await post({ queries: [] })).status).toBe(400);
    expect((await post({ queries: ["x y"], cursor: "nope" })).status).toBe(400);
    expect((await app.request("/v1/jobs/search", { method: "POST", body: "{}" })).status).toBe(401);
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
