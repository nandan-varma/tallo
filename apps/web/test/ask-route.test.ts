import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_ASK_BODY_BYTES } from "../src/lib/ask.ts";
import { POST } from "../src/pages/api/ai/ask.ts";

const askJobs = vi.fn();
vi.mock("@/lib/api", () => ({ askJobs: (...args: unknown[]) => askJobs(...args) }));

const ENDPOINT = "https://tallo.test/api/ai/ask";
const call = (request: Request) =>
  POST({ request } as unknown as Parameters<typeof POST>[0]) as Promise<Response>;

beforeEach(() => {
  askJobs.mockReset();
  askJobs.mockResolvedValue(
    new Response(JSON.stringify({ answer: { query: "go", items: [] }, trace: {} }), {
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
  );
});

describe("POST /api/ai/ask body guard", () => {
  it("forwards a valid JSON body to the API", async () => {
    const response = await call(
      new Request(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: " go ", profile: "Go developer" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(askJobs).toHaveBeenCalledTimes(1);
    expect(JSON.parse(askJobs.mock.calls[0]?.[0] as string)).toEqual({
      query: "go",
      profile: "Go developer",
    });
  });

  it("forwards a 20,000-char multibyte profile (over 32 KB as UTF-8) without a 413", async () => {
    // 20,000 three-byte characters: 60 KB of UTF-8. The earlier 32 KB cap rejected this valid profile.
    const profile = "界".repeat(20_000);
    const body = JSON.stringify({ query: "go", profile });
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(32 * 1024);
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(MAX_ASK_BODY_BYTES);

    const response = await call(
      new Request(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    expect(response.status).toBe(200);
    expect(askJobs).toHaveBeenCalledTimes(1);
    expect(JSON.parse(askJobs.mock.calls[0]?.[0] as string)).toEqual({ query: "go", profile });
  });

  it("returns 415 without forwarding when the content-type is not JSON", async () => {
    const response = await call(
      new Request(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ query: "go" }),
      }),
    );
    expect(response.status).toBe(415);
    expect(askJobs).not.toHaveBeenCalled();
  });

  it("returns 413 when the declared Content-Length is over the cap", async () => {
    const response = await call(
      new Request(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(MAX_ASK_BODY_BYTES + 1),
        },
        body: JSON.stringify({ query: "go" }),
      }),
    );
    expect(response.status).toBe(413);
    expect(askJobs).not.toHaveBeenCalled();
  });

  it("returns 413 for an undeclared body over the cap and never forwards it", async () => {
    const chunk = new TextEncoder().encode(`{"query":"go","profile":"${"p".repeat(8 * 1024)}`);
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
    });
    const response = await call(
      new Request(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(413);
    expect(askJobs).not.toHaveBeenCalled();
    // The read stops once the cap is passed: about cap / chunk pulls, plus one for the stream's read-ahead.
    expect(pulls).toBeLessThanOrEqual(Math.ceil(MAX_ASK_BODY_BYTES / (8 * 1024)) + 2);
  });

  it("returns 400 for a valid-size JSON body that fails validation", async () => {
    const response = await call(
      new Request(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(askJobs).not.toHaveBeenCalled();
  });
});
