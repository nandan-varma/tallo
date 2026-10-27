import { defaultResumeDoc, emptyResume } from "@tallo/contracts";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { auth, build, seedJob, usage } from "./support.ts";

/** A model that answers every call with this JSON, and records the prompts it saw. */
function answering(value: unknown) {
  const prompts: string[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(value) }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage,
        warnings: [],
      } as never;
    },
  });
  return { model, prompts };
}

const resume = () => ({
  ...emptyResume(),
  name: "Ada",
  experience: [
    {
      company: "Acme",
      title: "Engineer",
      location: "",
      start: "2020",
      end: "Present",
      bullets: ["Built APIs."],
    },
  ],
});

type App = ReturnType<typeof build>["app"];
const send = (app: App, path: string, method: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: auth,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("resume routes", () => {
  it("stores the base resume and a copy per posting, and lists them", async () => {
    const { app } = build(null);
    expect(await (await send(app, "/v1/resume", "GET")).json()).toBeNull();

    const doc = { ...defaultResumeDoc(), resume: resume() };
    expect((await send(app, "/v1/resume", "PUT", doc)).status).toBe(200);
    expect((await send(app, "/v1/resume?job=7", "PUT", doc)).status).toBe(200);

    const base = (await (await send(app, "/v1/resume", "GET")).json()) as { jobId: number | null };
    expect(base.jobId).toBeNull();
    const list = (await (await send(app, "/v1/resumes", "GET")).json()) as {
      jobId: number | null;
    }[];
    expect(list.map((item) => item.jobId).sort()).toEqual([7, null].sort());

    expect((await send(app, "/v1/resume?job=7", "DELETE")).status).toBe(204);
    expect(await (await send(app, "/v1/resume?job=7", "GET")).json()).toBeNull();
    expect((await send(app, "/v1/resume", "DELETE")).status).toBe(400);
  });

  it("rejects a malformed resume and needs a token", async () => {
    const { app } = build(null);
    expect((await send(app, "/v1/resume", "PUT", { resume: { name: 1 } })).status).toBe(400);
    expect((await app.request("/v1/resume")).status).toBe(401);
  });

  it("imports text into a resume without storing it", async () => {
    const { model } = answering(resume());
    const { app } = build(model);
    const response = await send(app, "/v1/resume/import", "POST", {
      text: "Ada, engineer at Acme since 2020.",
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { resume: { name: string } }).resume.name).toBe("Ada");
    expect(await (await send(app, "/v1/resume", "GET")).json()).toBeNull();
  });

  it("tailors to a posting's stored description, keeping the facts", async () => {
    const { model, prompts } = answering({
      headline: "Backend Engineer",
      summary: "",
      experience: [
        { company: "Acme", title: "Engineer", bullets: ["Built APIs for backend teams."] },
      ],
      projects: [],
      skills: [],
      changes: ["Reworded for backend"],
    });
    const { app, db, blobs } = build(model);
    await seedJob(db, blobs);

    const response = await send(app, "/v1/resume/tailor", "POST", { jobId: 1, resume: resume() });
    expect(response.status).toBe(200);
    const out = (await response.json()) as {
      resume: { headline: string; experience: { company: string; bullets: string[] }[] };
      changes: string[];
    };
    expect(out.resume.headline).toBe("Backend Engineer");
    expect(out.resume.experience[0]).toMatchObject({
      company: "Acme",
      bullets: ["Built APIs for backend teams."],
    });
    expect(out.changes).toEqual(["Reworded for backend"]);
    expect(prompts[0]).toContain("Senior Backend Engineer");
    expect(prompts[0]).toContain("Pay: $200,000.");
  });

  it("answers 404 for an unknown posting, 503 without a model, 502 when the model fails", async () => {
    const missing = build(answering({}).model);
    expect(
      (await send(missing.app, "/v1/resume/tailor", "POST", { jobId: 99, resume: resume() }))
        .status,
    ).toBe(404);

    const none = build(null).app;
    expect(
      (await send(none, "/v1/resume/edit", "POST", { resume: resume(), instruction: "shorten it" }))
        .status,
    ).toBe(503);

    const broken = build(answering({ nonsense: true }).model).app;
    const failed = await send(broken, "/v1/resume/edit", "POST", {
      resume: resume(),
      instruction: "shorten it",
    });
    expect(failed.status).toBe(502);
  });
});

/** A model that answers with plain text (the cover letter), not JSON. */
function writing(text: string) {
  const prompts: string[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return {
        content: [{ type: "text" as const, text }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage,
        warnings: [],
      } as never;
    },
  });
  return { model, prompts };
}

describe("cover letter and fit routes", () => {
  it("writes a cover letter for a posting's stored description", async () => {
    const { model, prompts } = writing("Dear Hiring Team,\n\nSincerely,\nAda");
    const { app, db, blobs } = build(model);
    await seedJob(db, blobs);

    const response = await send(app, "/v1/resume/cover-letter", "POST", {
      jobId: 1,
      resume: resume(),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ letter: "Dear Hiring Team,\n\nSincerely,\nAda" });
    expect(prompts[0]).toContain("Senior Backend Engineer");
    expect(prompts[0]).toContain("Pay: $200,000.");
  });

  it("checks the fit against a posting and returns the guarded answer", async () => {
    const { model, prompts } = answering({
      verdict: "stretch",
      summary: "Strong on APIs. Backend scale is not shown.",
      matches: [
        { requirement: "Pay: $200,000.", evidence: "Built APIs." },
        { requirement: "Pay: $200,000.", evidence: "Ran a team of forty." },
      ],
      gaps: [{ requirement: "Senior Backend Engineer", advice: "Not covered in your resume." }],
    });
    const { app, db, blobs } = build(model);
    await seedJob(db, blobs);

    const response = await send(app, "/v1/resume/fit", "POST", { jobId: 1, resume: resume() });
    expect(response.status).toBe(200);
    const out = (await response.json()) as { verdict: string; matches: unknown[]; gaps: unknown[] };
    expect(out.verdict).toBe("stretch");
    expect(out.matches).toEqual([{ requirement: "Pay: $200,000.", evidence: "Built APIs." }]);
    expect(out.gaps).toHaveLength(1);
    expect(prompts[0]).toContain("Senior Backend Engineer");
  });

  it("answers 404 for an unknown posting and 503 without a model", async () => {
    for (const path of ["/v1/resume/cover-letter", "/v1/resume/fit"]) {
      const missing = build(writing("x").model);
      expect((await send(missing.app, path, "POST", { jobId: 99, resume: resume() })).status).toBe(
        404,
      );

      const none = build(null);
      await seedJob(none.db, none.blobs);
      expect((await send(none.app, path, "POST", { jobId: 1, resume: resume() })).status).toBe(503);
    }
  });
});

describe("interview prep route", () => {
  it("prepares questions for a posting and returns the guarded answer", async () => {
    const { model, prompts } = answering({
      questions: [
        {
          question: "Tell me about your API work.",
          angle: "Lead with the APIs you built at Acme.",
          evidence: "Built APIs.",
        },
        {
          question: "Have you run Kubernetes?",
          angle: "Not in your resume.",
          evidence: "Ran Kubernetes.",
        },
      ],
      ask: ["How is the API latency budget set?"],
    });
    const { app, db, blobs } = build(model);
    await seedJob(db, blobs);

    const response = await send(app, "/v1/resume/prep", "POST", { jobId: 1, resume: resume() });
    expect(response.status).toBe(200);
    const out = (await response.json()) as { questions: { evidence: string }[]; ask: string[] };
    expect(out.questions.map((item) => item.evidence)).toEqual(["Built APIs.", ""]);
    expect(out.ask).toEqual(["How is the API latency budget set?"]);
    expect(prompts[0]).toContain("Senior Backend Engineer");
  });

  it("answers 404 for an unknown posting and 503 without a model", async () => {
    const missing = build(answering({ questions: [], ask: [] }).model);
    expect(
      (await send(missing.app, "/v1/resume/prep", "POST", { jobId: 99, resume: resume() })).status,
    ).toBe(404);

    const none = build(null);
    await seedJob(none.db, none.blobs);
    expect(
      (await send(none.app, "/v1/resume/prep", "POST", { jobId: 1, resume: resume() })).status,
    ).toBe(503);
  });
});
