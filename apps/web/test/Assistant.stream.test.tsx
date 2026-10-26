// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sse = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock("ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("ai")>();
  return {
    ...original,
    DefaultChatTransport: class {
      async sendMessages() {
        const chunks = sse.lines;
        return new ReadableStream({
          async start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(JSON.parse(chunk));
              await new Promise((r) => setTimeout(r, 2));
            }
            controller.close();
          },
        });
      }
      async reconnectToStream() {
        return null;
      }
    },
  };
});

const HITS = Array.from({ length: 5 }, (_, i) => ({
  id: String(i + 1),
  title: `Data Engineer ${i + 1}`,
  company: `Co ${i + 1}`,
  location: "Seattle, WA",
  workMode: null,
  pay: null,
  postedAt: null,
  department: null,
}));

beforeEach(() => {
  sessionStorage.clear();
  sse.lines = readFileSync(`${import.meta.dirname}/fixtures/turn.sse`, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => l.slice(6));
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: q.includes("min-width"),
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 1400 });
  Element.prototype.scrollTo = vi.fn() as never;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ hits: HITS, nextCursor: null })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a real recorded turn through the real useChat", () => {
  it("fills the list when the search finishes and never empties it again", async () => {
    const { Assistant } = await import("../src/components/assistant/Assistant.tsx");
    render(<Assistant hasResume={false} />);
    const box = await screen.findByLabelText("Message the assistant");
    fireEvent.change(box, { target: { value: "entry-level data roles in Washington" } });
    fireEvent.keyDown(box, { key: "Enter" });

    const rows = () =>
      screen.queryAllByRole("button").filter((b) => /Data Engineer \d/.test(b.textContent ?? ""));
    await waitFor(() => expect(rows()).toHaveLength(5), { timeout: 4000 });

    // Let the rest of the stream arrive; the list must still be there at the end.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull(), {
      timeout: 8000,
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(rows()).toHaveLength(5);
  });
});
