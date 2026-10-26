import type { Item, Trace } from "@tallo/search-ai";
import { describe, expect, it } from "vitest";
import {
  AskError,
  askFailure,
  buildAskBody,
  errorDetail,
  formatElapsed,
  itemHref,
  MAX_ASK_BODY_BYTES,
  MAX_PROFILE_CHARS,
  MAX_QUERY_CHARS,
  parseAskBody,
  parseAskResult,
  readAskJson,
  readStoredProfile,
  runAsk,
  sortByRank,
  traceSections,
} from "../src/lib/ask.ts";

const item = (overrides: Partial<Item> = {}): Item => ({
  rank: 1,
  id: "42",
  title: "Backend Engineer",
  company: "Acme",
  locations: ["Remote, US"],
  verdict: "strong",
  fit: 88,
  reason: "Go and Postgres match.",
  evidence: ["Experience with Go and PostgreSQL"],
  unknowns: ["Salary"],
  ...overrides,
});

const trace = {
  understand: { titles: ["Backend Engineer", "Platform Engineer"], queries: ["go", "postgres"] },
  recall: { queries: 2, candidates: 300 },
  triage: {
    batches: 3,
    strong: 12,
    maybe: 40,
    no: 248,
    defaulted: 0,
    decisions: [],
  },
  deep: {
    reads: 6,
    descriptionChars: 48210,
    chunks: 7,
    emptyDescriptions: 1,
    droppedEvidence: 0,
    scored: [{ id: "42", fit: 88 }],
  },
  answer: { items: 1 },
  tokens: { fast: { input: 12000, output: 900 }, smart: { input: 30500, output: 1200 } },
  retries: 0,
} satisfies Trace;

const response = { answer: { query: "go backend", items: [item()] }, trace };

describe("buildAskBody", () => {
  it("trims the query and omits a blank profile", () => {
    expect(buildAskBody("  go backend \n", "   ")).toEqual({ query: "go backend" });
  });

  it("keeps a trimmed profile", () => {
    expect(buildAskBody("go", "\n# Profile\n- Go\n")).toEqual({
      query: "go",
      profile: "# Profile\n- Go",
    });
  });
});

describe("parseAskBody (proxy guard)", () => {
  it("accepts a query with or without a profile", () => {
    expect(parseAskBody({ query: "go" })).toEqual({ query: "go" });
    expect(parseAskBody({ query: " go ", profile: "x" })).toEqual({ query: "go", profile: "x" });
  });

  it("rejects missing, blank or overlong queries", () => {
    expect(parseAskBody({})).toBeNull();
    expect(parseAskBody({ query: "   " })).toBeNull();
    expect(parseAskBody({ query: "q".repeat(MAX_QUERY_CHARS + 1) })).toBeNull();
    expect(parseAskBody(null)).toBeNull();
    expect(parseAskBody(["go"])).toBeNull();
  });

  it("rejects a non-string or overlong profile", () => {
    expect(parseAskBody({ query: "go", profile: 3 })).toBeNull();
    expect(parseAskBody({ query: "go", profile: "p".repeat(MAX_PROFILE_CHARS + 1) })).toBeNull();
  });
});

describe("readAskJson (proxy body guard)", () => {
  const json = { "content-type": "application/json" };
  const post = (body: BodyInit, headers: HeadersInit = json) =>
    new Request("https://tallo.test/api/ai/ask", { method: "POST", headers, body });

  it("parses a valid JSON body, with or without a charset parameter", async () => {
    expect(await readAskJson(post('{"query":"go"}'))).toEqual({ ok: true, value: { query: "go" } });
    const withCharset = post('{"query":"go"}', {
      "content-type": "application/json; charset=utf-8",
    });
    expect(await readAskJson(withCharset)).toEqual({ ok: true, value: { query: "go" } });
  });

  it("returns 415 for a non-JSON or missing content-type", async () => {
    const text = post('{"query":"go"}', { "content-type": "text/plain" });
    expect(await readAskJson(text)).toMatchObject({ ok: false, status: 415 });
    const none = new Request("https://tallo.test/api/ai/ask", { method: "POST", body: "{}" });
    expect(await readAskJson(none)).toMatchObject({ ok: false, status: 415 });
  });

  it("returns 413 when the declared Content-Length is over the cap", async () => {
    const declared = post('{"query":"go"}', {
      ...json,
      "content-length": String(MAX_ASK_BODY_BYTES + 1),
    });
    expect(await readAskJson(declared)).toMatchObject({ ok: false, status: 413 });
  });

  it("returns 413 when the bytes exceed the cap even if the declared length is small", async () => {
    const big = JSON.stringify({ query: "go", profile: "p".repeat(MAX_ASK_BODY_BYTES) });
    expect(await readAskJson(post(big, { ...json, "content-length": "10" }))).toMatchObject({
      ok: false,
      status: 413,
    });
  });

  it("returns 413 for an undeclared (streamed) body over the cap", async () => {
    const chunk = new TextEncoder().encode("x".repeat(8 * 1024));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    const request = new Request("https://tallo.test/api/ai/ask", {
      method: "POST",
      headers: json,
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();
    expect(await readAskJson(request)).toMatchObject({ ok: false, status: 413 });
  });

  it("returns 400 for invalid JSON and for an empty body", async () => {
    expect(await readAskJson(post("{nope"))).toMatchObject({ ok: false, status: 400 });
    expect(await readAskJson(post(""))).toMatchObject({ ok: false, status: 400 });
  });
});

describe("readStoredProfile", () => {
  it("returns empty text when nothing is stored and caps the length", () => {
    expect(readStoredProfile(null)).toBe("");
    expect(readStoredProfile("abc")).toBe("abc");
    expect(readStoredProfile("x".repeat(MAX_PROFILE_CHARS + 5))).toHaveLength(MAX_PROFILE_CHARS);
  });
});

describe("parseAskResult", () => {
  it("accepts the { answer, trace } contract", () => {
    const parsed = parseAskResult(response);
    expect(parsed?.answer.items).toHaveLength(1);
    expect(parsed?.trace.recall.candidates).toBe(300);
  });

  it("accepts an empty answer", () => {
    expect(parseAskResult({ answer: { query: "q", items: [] }, trace })?.answer.items).toEqual([]);
  });

  it("rejects a missing answer or trace", () => {
    expect(parseAskResult({ trace })).toBeNull();
    expect(parseAskResult({ answer: { query: "q", items: [] } })).toBeNull();
    expect(parseAskResult("nope")).toBeNull();
  });

  it("rejects the whole answer when any item is malformed", () => {
    expect(
      parseAskResult({
        answer: { query: "q", items: [item(), { ...item(), verdict: "no" }] },
        trace,
      }),
    ).toBeNull();
    expect(
      parseAskResult({ answer: { query: "q", items: [{ ...item(), evidence: "quote" }] }, trace }),
    ).toBeNull();
    expect(
      parseAskResult({ answer: { query: "q", items: [{ ...item(), fit: Number.NaN }] }, trace }),
    ).toBeNull();
  });

  it("allows a null fit for items that were not deep-read", () => {
    expect(
      parseAskResult({ answer: { query: "q", items: [item({ fit: null })] }, trace }),
    ).not.toBeNull();
  });
});

describe("sortByRank and itemHref", () => {
  it("orders best fit first without mutating the input", () => {
    const items = [
      item({ rank: 3, id: "3" }),
      item({ rank: 1, id: "1" }),
      item({ rank: 2, id: "2" }),
    ];
    expect(sortByRank(items).map((entry) => entry.id)).toEqual(["1", "2", "3"]);
    expect(items.map((entry) => entry.id)).toEqual(["3", "1", "2"]);
  });

  it("links only numeric job ids to the detail page", () => {
    expect(itemHref("42")).toBe("/jobs/42");
    expect(itemHref("42; drop")).toBeNull();
    expect(itemHref("")).toBeNull();
  });
});

describe("errorDetail", () => {
  it("reads error or message from a JSON body", () => {
    expect(errorDetail('{"error":"Bad query"}')).toBe("Bad query");
    expect(errorDetail('{"message":" Slow down "}')).toBe("Slow down");
  });

  it("ignores plain text, other shapes and blank values", () => {
    expect(errorDetail("Service Unavailable")).toBeNull();
    expect(errorDetail('{"error":""}')).toBeNull();
    expect(errorDetail("[1]")).toBeNull();
  });
});

describe("askFailure", () => {
  it("explains the common statuses", () => {
    expect(askFailure(503)).toMatch(/not configured/);
    expect(askFailure(401)).toMatch(/access key/);
    expect(askFailure(404)).toMatch(/not available/);
    expect(askFailure(504)).toMatch(/timed out/);
    expect(askFailure(null)).toMatch(/Could not reach/);
  });

  it("uses the server detail for a rejected request, else a generic message", () => {
    expect(askFailure(400, "Query too long")).toBe("Query too long");
    expect(askFailure(400)).toMatch(/rejected/);
    expect(askFailure(500)).toBe("The search failed on the server (HTTP 500).");
    expect(askFailure(500, "Boom")).toBe("Boom");
  });
});

describe("formatElapsed", () => {
  it("formats seconds and minutes", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(42.9)).toBe("42s");
    expect(formatElapsed(65)).toBe("1m 05s");
    expect(formatElapsed(-3)).toBe("0s");
  });
});

describe("traceSections", () => {
  it("renders the reported counts and omits sections the engine did not report", () => {
    const sections = traceSections(trace);
    const titles = sections.map((section) => section.title);
    expect(titles).toEqual([
      "Understand",
      "Recall",
      "Triage",
      "Deep reads",
      "Answer",
      "Tokens",
      "Model retries",
    ]);
    const deep = sections.find((section) => section.title === "Deep reads");
    expect(deep?.rows).toContainEqual({ label: "Description chars read", value: "48,210" });
    const tokens = sections.find((section) => section.title === "Tokens");
    expect(tokens?.rows).toContainEqual({ label: "Smart output", value: "1,200" });
  });

  it("never invents a zero for a missing field", () => {
    const partial = { recall: { candidates: 5 } } as unknown as Trace;
    const sections = traceSections(partial);
    expect(sections).toEqual([{ title: "Recall", rows: [{ label: "Candidates", value: "5" }] }]);
  });

  it("adds the browser-measured round trip, rounded to whole seconds", () => {
    const sections = traceSections({} as Trace, 12.4);
    expect(sections).toEqual([
      {
        title: "Timing",
        rows: [{ label: "Round trip, measured in browser (s)", value: "12" }],
      },
    ]);
  });
});

describe("runAsk", () => {
  const jsonResponse = (status: number, body: unknown) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  it("posts the body as JSON to the proxy and returns the validated result", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse(200, response);
    }) as typeof fetch;

    const result = await runAsk({ query: "go", profile: "Go" }, { fetcher });

    expect(result.answer.items[0]?.title).toBe("Backend Engineer");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/ai/ask");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ query: "go", profile: "Go" });
  });

  it("maps a 503 with its server message to a clear failure", async () => {
    const fetcher = (async () => jsonResponse(503, { error: "no key" })) as typeof fetch;
    await expect(runAsk({ query: "go" }, { fetcher })).rejects.toMatchObject({
      kind: "failed",
      message: expect.stringMatching(/not configured/),
    });
  });

  it("uses the server detail for a 400", async () => {
    const fetcher = (async () => jsonResponse(400, { error: "Query is empty" })) as typeof fetch;
    await expect(runAsk({ query: "go" }, { fetcher })).rejects.toMatchObject({
      message: "Query is empty",
    });
  });

  it("rejects a 200 with an unexpected shape", async () => {
    const fetcher = (async () => jsonResponse(200, { items: [] })) as typeof fetch;
    await expect(runAsk({ query: "go" }, { fetcher })).rejects.toBeInstanceOf(AskError);
  });

  it("rejects a 200 whose body is not JSON", async () => {
    const fetcher = (async () => jsonResponse(200, "<html>")) as typeof fetch;
    await expect(runAsk({ query: "go" }, { fetcher })).rejects.toMatchObject({ kind: "failed" });
  });

  it("reports a network failure as unreachable", async () => {
    const fetcher = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(runAsk({ query: "go" }, { fetcher })).rejects.toMatchObject({
      kind: "failed",
      message: expect.stringMatching(/Could not reach/),
    });
  });

  it("aborts after the timeout and reports a timeout", async () => {
    const fetcher = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as typeof fetch;
    await expect(runAsk({ query: "go" }, { fetcher, timeoutMs: 5 })).rejects.toMatchObject({
      kind: "timeout",
      message: expect.stringMatching(/timed out/),
    });
  });

  it("reports a user cancel distinctly from a failure", async () => {
    const controller = new AbortController();
    const fetcher = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as typeof fetch;
    const pending = runAsk({ query: "go" }, { fetcher, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
  });
});
