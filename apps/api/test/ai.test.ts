import { defaultResumeDoc } from "@tallo/contracts";
import { saveProfile, saveResume } from "@tallo/db";
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

  it("gives the agent the built resume and the person's notes, and says so when there is none", async () => {
    const seen = scripted([{ text: "ok" }]);
    const a = build(seen.model);
    const doc = defaultResumeDoc();
    doc.resume.name = "Ada Lovelace";
    doc.resume.summary = "Rustacean, 9 years.";
    await saveResume(a.db, doc);
    await saveProfile(a.db, { profile: "Remote only." });
    await (await chat(a.app, "hi")).text();
    expect(seen.prompts[0]).toContain("Rustacean, 9 years.");
    expect(seen.prompts[0]).toContain("Remote only.");

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
    const json = (await page.json()) as { hits: { title: string }[]; nextOffset: number | null };
    expect(json.hits.map((h) => h.title)).toEqual(["Senior Backend Engineer"]);
    expect(json.nextOffset).toBeNull();

    expect((await post({ queries: [] })).status).toBe(400);
    expect((await post({ queries: ["x y"], offset: 300 })).status).toBe(400);
    expect((await post({ queries: ["x y"], offset: -1 })).status).toBe(400);
    expect((await app.request("/v1/jobs/search", { method: "POST", body: "{}" })).status).toBe(401);
  });
});

describe("profile routes", () => {
  it("is null until saved, then round-trips and overwrites", async () => {
    const { app } = build(null);
    const empty = await app.request("/v1/profile", { headers: auth });
    expect(await empty.json()).toBeNull();

    const put = (profile: string) =>
      app.request("/v1/profile", {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ profile }),
      });
    expect((await put("Remote only.")).status).toBe(200);
    expect((await put("Remote or Boston.")).status).toBe(200);
    const got = (await (await app.request("/v1/profile", { headers: auth })).json()) as {
      profile: string;
    };
    expect(got.profile).toBe("Remote or Boston.");
  });

  it("rejects oversized notes", async () => {
    const { app } = build(null);
    const response = await app.request("/v1/profile", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ profile: "x".repeat(30_001) }),
    });
    expect(response.status).toBe(400);
  });
});

describe("chat spend", () => {
  const today = () => new Date().toISOString().slice(0, 10);

  it("adds every step of a turn to the day's ledger", async () => {
    const { model } = scripted([
      { tool: { name: "search_jobs", input: { queries: ["backend engineer"] } } },
      { text: "Found one role." },
    ]);
    const { app, db, blobs, ledger } = build(model);
    await seedJob(db, blobs);
    await (await chat(app, "backend roles")).text();
    expect(await ledger.used(today())).toBe(20);
  });

  it("refuses a turn when the day's ceiling is reached", async () => {
    const { model, prompts } = scripted([{ text: "hi" }]);
    const { app, ledger } = build(model, { limit: 50 });
    await ledger.add(today(), 50);
    const response = await chat(app, "hi");
    expect(response.status).toBe(429);
    expect(prompts).toHaveLength(0);
  });

  it("shows the model only the recent turns of a long conversation", async () => {
    const { model, prompts } = scripted([{ text: "ok" }]);
    const { app } = build(model);
    const messages = Array.from({ length: 101 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: `turn-${i};` }],
    }));
    const response = await app.request("/v1/ai/chat", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ messages }),
    });
    await response.text();
    expect(prompts[0]).toContain("turn-100;");
    expect(prompts[0]).not.toContain("turn-10;");
  });
});
