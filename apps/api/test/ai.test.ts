import { gzip, sha256 } from "@tallo/catalog";
import { jdKey, memoryBlobs, schema } from "@tallo/db";
import { testDb } from "@tallo/db/testing";
import type { LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_MAX_MODEL_CALLS, modelsFromEnv } from "../src/ai.ts";
import { createApp } from "../src/app.ts";

const READ = "read-token";
const INGEST = "ingest-token";
const PROFILE = "# Profile\n\n- Backend engineer, 8 years, TypeScript.\n";

type Stage = "understand" | "triage" | "notes" | "judge" | "unknown";

// Stage is read from the system tag "[search-ai:<stage>]". Prompt text is what the model sees.
function promptText(prompt: unknown): string {
  return (prompt as { content: unknown }[])
    .map((message) => {
      const content = message.content;
      if (typeof content === "string") return content;
      return (content as { type: string; text?: string }[])
        .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
        .join("");
    })
    .join("\n");
}

function reply(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: {
      inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 7, text: 7, reasoning: undefined },
    },
    warnings: [],
  };
}

/** A fake model that records every prompt it receives and answers by stage. */
function fakeModel(
  prompts: { stage: Stage; text: string }[],
  respond: (stage: Stage, text: string) => string,
) {
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      const text = promptText(options.prompt);
      const stage = (/\[search-ai:(\w+)\]/.exec(text)?.[1] ?? "unknown") as Stage;
      prompts.push({ stage, text });
      return reply(respond(stage, text));
    },
  });
}

/** Answers every stage: understand titles, triage each posting as maybe, judge a fit. */
function respondDefault(stage: Stage, text: string): string {
  switch (stage) {
    case "understand":
      return JSON.stringify({
        titles: ["Backend Engineer"],
        queries: ["backend"],
        seniority: null,
        mustHave: [],
        dealBreakers: [],
      });
    case "triage": {
      const block = /<postings>(\[[\s\S]*\])<\/postings>/.exec(text)?.[1] ?? "[]";
      const ids = (JSON.parse(block) as { id: string }[]).map((p) => p.id);
      return JSON.stringify({
        decisions: ids.map((id) => ({ id, verdict: "maybe", reason: "plausible" })),
      });
    }
    case "notes":
      return JSON.stringify({ notes: "notes" });
    case "judge":
      return JSON.stringify({ fit: 80, reason: "Good match", evidence: [], unknowns: [] });
    default:
      throw new Error(`unexpected stage ${stage}`);
  }
}

const source = {
  id: "greenhouse:acme",
  platform: "greenhouse",
  key: "acme",
  company: "Acme",
  params: {},
};

const now = () => Math.floor(Date.now() / 1000);

type Engine = { fast: LanguageModel; smart: LanguageModel };

function setup(options: { models?: () => Engine | null; respond?: typeof respondDefault } = {}) {
  const db = testDb();
  const blobs = memoryBlobs();
  const prompts: { stage: Stage; text: string }[] = [];
  const engine = (): Engine => {
    const model = fakeModel(prompts, options.respond ?? respondDefault);
    return { fast: model, smart: model };
  };
  const app = createApp({
    db,
    blobs,
    readToken: READ,
    ingestToken: INGEST,
    models: options.models ?? engine,
  });
  const call = (path: string, token: string | null, init: RequestInit & { json?: unknown } = {}) =>
    app.request(path, {
      ...init,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.json ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      ...(init.json ? { body: JSON.stringify(init.json) } : {}),
    });
  return { call, db, blobs, prompts };
}

/** One open, visible job with a stored description. Returns its database id. */
async function seedJob(
  db: ReturnType<typeof testDb>,
  blobs: ReturnType<typeof memoryBlobs>,
  args: {
    postingId: string;
    description: string;
    closed?: boolean;
    title?: string;
    dupOf?: number;
  },
): Promise<number> {
  const text = args.description;
  const jdHash = await sha256(text);
  await blobs.put(jdKey(jdHash), await gzip(new TextEncoder().encode(text)));
  await db
    .insert(schema.sources)
    .values({ ...source, companySlug: "acme", lastListedAt: now(), params: {} })
    .onConflictDoNothing();
  const inserted = await db
    .insert(schema.jobs)
    .values({
      sourceId: source.id,
      postingId: args.postingId,
      company: "Acme",
      companySlug: "acme",
      title: args.title ?? "Backend Engineer",
      classifierVersion: 1,
      excerpt: text.slice(0, 80),
      jdHash,
      jdBytes: text.length,
      sourceHash: "b".repeat(64),
      facts: {},
      sortAt: 1000 + Number(args.postingId),
      firstSeenAt: 1,
      updatedAt: 1,
      department: "Engineering",
      employmentType: "full_time",
      workMode: "remote",
      countryCode: "US",
      locationText: "Remote, US",
      closedAt: args.closed ? 2 : null,
      dupOf: args.dupOf ?? null,
      salaryMinAnnual: 150000,
      salaryMaxAnnual: 180000,
      salaryCurrency: "USD",
    })
    .returning({ id: schema.jobs.id });
  return inserted[0]?.id ?? 0;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /v1/ai/ask", () => {
  const body = { query: "backend engineer remote", profile: PROFILE, deepReads: 1 };

  it("requires the read token", async () => {
    const { call } = setup();
    expect((await call("/v1/ai/ask", null, { method: "POST", json: body })).status).toBe(401);
    expect((await call("/v1/ai/ask", "wrong", { method: "POST", json: body })).status).toBe(401);
  });

  it("rejects invalid bodies before any model is built", async () => {
    let built = 0;
    const { call } = setup({
      models: () => {
        built += 1;
        return null;
      },
    });
    const bad: unknown[] = [
      {},
      { query: "" },
      { query: "   " },
      { query: "x".repeat(501) },
      { query: "ok", deepReads: 16 },
      { query: "ok", deepReads: -1 },
      { query: "ok", deepReads: 1.5 },
      { query: "ok", profile: "p".repeat(20_001) },
    ];
    for (const json of bad) {
      expect((await call("/v1/ai/ask", READ, { method: "POST", json })).status).toBe(400);
    }
    expect(built).toBe(0);
    expect(
      (
        await call("/v1/ai/ask", READ, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        })
      ).status,
    ).toBe(400);
  });

  it("rejects bodies over the size cap with 413", async () => {
    const { call } = setup();
    const res = await call("/v1/ai/ask", READ, {
      method: "POST",
      json: { query: "ok", profile: "p".repeat(200_000) },
    });
    expect(res.status).toBe(413);
  });

  it("answers 503 with a clear message when no AI key is configured", async () => {
    const unconfigured = setup({ models: () => null });
    const res = await unconfigured.call("/v1/ai/ask", READ, { method: "POST", json: body });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("OPENCODE_API_KEY") });

    // Same answer when the env has no key at all (the production factory returns null).
    expect(modelsFromEnv({})).toBeNull();
    const noFactory = createApp({
      db: testDb(),
      blobs: memoryBlobs(),
      readToken: READ,
      ingestToken: INGEST,
    });
    expect(
      (
        await noFactory.request("/v1/ai/ask", {
          method: "POST",
          headers: { authorization: `Bearer ${READ}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(503);
  });

  it("answers 503 when a configured model role is broken", async () => {
    const { call } = setup({
      models: () => {
        throw new Error('AI_MODEL_FAST is not set (expected "provider:model")');
      },
    });
    expect((await call("/v1/ai/ask", READ, { method: "POST", json: body })).status).toBe(503);
  });

  it("returns the engine answer and trace, logging counts only", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(String(line)));
    const { call, db, blobs } = setup();
    const id = await seedJob(db, blobs, {
      postingId: "7",
      description: "We build backend services in TypeScript. Remote, US only.",
    });

    const res = await call("/v1/ai/ask", READ, { method: "POST", json: body });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const result = (await res.json()) as {
      answer: {
        query: string;
        items: { id: string; rank: number; verdict: string; fit: number }[];
      };
      trace: { recall: { candidates: number }; deep: { reads: number } };
    };
    expect(result.answer.query).toBe(body.query);
    expect(result.answer.items).toEqual([
      expect.objectContaining({ id: String(id), rank: 1, verdict: "maybe", fit: 80 }),
    ]);
    expect(result.trace.recall.candidates).toBe(1);
    expect(result.trace.deep.reads).toBe(1);

    // Counts and ids only: no query, profile or description text reaches the logs.
    expect(logs.length).toBe(1);
    expect(logs[0]).not.toContain("backend engineer remote");
    expect(logs[0]).not.toContain("TypeScript");
    expect(logs[0]).not.toContain("Remote, US only");
    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({ event: "ai.ask", candidates: 1 });
  });

  it("gives the engine the full description, never truncated (35k chars)", async () => {
    const { call, db, blobs, prompts } = setup({ respond: respondDefault });
    const marker = "END-OF-DESCRIPTION-MARKER";
    const lines: string[] = [];
    for (let i = 0; lines.join("\n").length < 35_000; i++) {
      lines.push(`Line ${i}: we run backend services in TypeScript on Postgres, on call weekly.`);
    }
    const description = `${lines.join("\n")}\n${marker}`;
    expect(description.length).toBeGreaterThan(30_000);
    await seedJob(db, blobs, { postingId: "9", description });

    const res = await call("/v1/ai/ask", READ, { method: "POST", json: body });
    expect(res.status).toBe(200);

    // The engine reads an oversized description in consecutive parts; the parts must rebuild it exactly.
    const parts = prompts
      .filter((p) => p.stage === "notes")
      .map((p) => /<part index="\d+" of="\d+">\n([\s\S]*?)\n<\/part>/.exec(p.text)?.[1] ?? "");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(description);
    expect(parts.at(-1)?.endsWith(marker)).toBe(true);
    const judged = (await res.json()) as { trace: { deep: { descriptionChars: number } } };
    expect(judged.trace.deep.descriptionChars).toBe(description.length);
  });

  it("never passes closed or hidden jobs to the engine", async () => {
    const { call, db, blobs, prompts } = setup();
    const visible = await seedJob(db, blobs, { postingId: "1", description: "backend a" });
    await seedJob(db, blobs, { postingId: "2", description: "backend b", closed: true });

    const res = await call("/v1/ai/ask", READ, { method: "POST", json: { query: "backend" } });
    const result = (await res.json()) as { trace: { recall: { candidates: number } } };
    expect(result.trace.recall.candidates).toBe(1);
    const triage = prompts.find((p) => p.stage === "triage")?.text ?? "";
    expect(triage).toContain(`"id":"${visible}"`);
    expect(triage).not.toContain("backend b");
  });

  it("never passes a duplicate (dup_of set) row to the engine", async () => {
    const { call, db, blobs, prompts } = setup();
    const canonical = await seedJob(db, blobs, { postingId: "1", description: "backend a" });
    await seedJob(db, blobs, {
      postingId: "2",
      description: "backend duplicate text",
      dupOf: canonical,
    });

    const res = await call("/v1/ai/ask", READ, { method: "POST", json: { query: "backend" } });
    expect(res.status).toBe(200);
    const result = (await res.json()) as { trace: { recall: { candidates: number } } };
    expect(result.trace.recall.candidates).toBe(1);
    const triage = prompts.find((p) => p.stage === "triage")?.text ?? "";
    expect(triage).toContain(`"id":"${canonical}"`);
    expect(triage).not.toContain("duplicate text");
    // The engine never asks for a description of the duplicate either.
    expect(prompts.some((p) => p.text.includes("duplicate text"))).toBe(false);
  });

  it("fits the worst default ask under the model-call ceiling (150)", async () => {
    // understand (1) + triage (1 batch) + 15 deep reads of 170k descriptions (8 parts + judge = 9 each)
    // = 137 calls. The old ceiling of 60 stopped this ask; the 150 ceiling runs it to the end.
    const { call, db, blobs, prompts } = setup();
    const description = "backend ".repeat(21_250); // 170k chars: 8 parts at the default 24k part size
    for (let i = 0; i < 15; i++) {
      await seedJob(db, blobs, {
        postingId: String(100 + i),
        description: `${description}${i}`,
        title: `Backend Engineer ${i}`,
      });
    }
    const res = await call("/v1/ai/ask", READ, {
      method: "POST",
      json: { query: "backend", deepReads: 15 },
    });
    expect(res.status).toBe(200);
    expect(AI_MAX_MODEL_CALLS).toBe(150);
    expect(prompts.length).toBe(1 + 1 + 15 * 9);
    expect(prompts.length).toBeLessThanOrEqual(AI_MAX_MODEL_CALLS);
  });

  it("returns 500 with no content when the engine throws", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => void logs.push(String(line)));
    const { call, db, blobs } = setup({
      respond: (stage, text) => {
        if (stage === "judge") throw new Error("upstream said: secret prompt text");
        return respondDefault(stage, text);
      },
    });
    await seedJob(db, blobs, { postingId: "3", description: "backend" });
    const res = await call("/v1/ai/ask", READ, { method: "POST", json: body });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "AI search failed" });
    expect(logs.join("\n")).not.toContain("secret prompt text");
    expect(logs.join("\n")).toContain("ai.ask.failed");
  });
});
