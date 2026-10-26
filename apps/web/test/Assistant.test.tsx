// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hit = (id: number, title: string) => ({
  id: String(id),
  title,
  company: `Company ${id}`,
  location: "Seattle, WA",
  workMode: "hybrid",
  pay: "USD 150000-180000 per year",
  postedAt: "2026-10-20",
  department: null,
});
const DB_HITS = [hit(1, "Data Engineer"), hit(2, "Platform Engineer"), hit(3, "Backend Engineer")];

// The chat stream is the AI SDK's job; here it is a finished conversation in which the assistant searched
// and left one note. Everything else (the list, the posting, the layout) is the real component tree.
const conversation = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "data roles in Washington" }] },
  {
    id: "a1",
    role: "assistant",
    parts: [
      {
        type: "tool-search_jobs",
        toolCallId: "s1",
        state: "output-available",
        input: { queries: ["data engineer"], locations: ["Seattle", "WA"] },
        output: { hits: DB_HITS },
      },
      {
        type: "tool-explain_jobs",
        toolCallId: "n1",
        state: "output-available",
        input: { notes: [] },
        output: {
          notes: [{ id: "2", why: "Closest to your platform background.", evidence: [] }],
          dropped: 0,
        },
      },
      { type: "text", text: "I searched Seattle and the rest of Washington." },
    ],
  },
];

vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: conversation,
    status: "ready",
    error: undefined,
    sendMessage: vi.fn(),
    stop: vi.fn(),
    regenerate: vi.fn(),
    setMessages: vi.fn(),
  }),
}));

const detail = (id: number) => ({
  id,
  title: DB_HITS[id - 1]?.title,
  company: `Company ${id}`,
  companySlug: `company-${id}`,
  locationText: "Seattle, WA",
  workMode: "hybrid",
  postedAt: 1_792_000_000,
  sortAt: 1_792_000_000,
  salaryMinAnnual: null,
  salaryMaxAnnual: null,
  salaryCurrency: null,
  expMinYears: null,
  department: null,
  employmentType: null,
  applyUrl: `https://example.com/apply/${id}`,
  url: null,
  city: null,
  region: null,
  countryCode: "US",
  excerpt: "",
  facts: {},
  description: `Full description of job ${id}.\nMinimum 5 years.`,
  variants: [],
});

function stubBrowser(desktop: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: desktop && query.includes("min-width"),
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
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/search") {
        return Response.json({ hits: DB_HITS, nextCursor: null });
      }
      const job = /\/api\/jobs\/(\d+)\.json/.exec(url)?.[1];
      if (job) return Response.json(detail(Number(job)));
      throw new Error(`unexpected fetch ${url} ${init?.method ?? "GET"}`);
    }),
  );
}

async function mount() {
  const { Assistant } = await import("../src/components/assistant/Assistant.tsx");
  return render(<Assistant hasProfile={false} />);
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Assistant (desktop)", () => {
  beforeEach(() => stubBrowser(true));

  it("lists the database's results for the assistant's search, with its note on the job it noted", async () => {
    await mount();
    const list = await screen.findByRole("list", { name: "Search results" });
    expect(within(list).getAllByRole("button")).toHaveLength(3);
    expect(within(list).getByText("Closest to your platform background.")).toBeTruthy();
    // The search the list ran is exactly what the assistant asked for.
    const call = vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/search");
    expect(call).toBeDefined();
    expect(JSON.parse(String((call?.[1] as RequestInit | undefined)?.body))).toMatchObject({
      queries: ["data engineer"],
      locations: ["Seattle", "WA"],
    });
  });

  it("opens a posting beside the list and lets you move to another one", async () => {
    await mount();
    const list = await screen.findByRole("list", { name: "Search results" });

    fireEvent.click(within(list).getByText("Data Engineer"));
    expect(await screen.findByRole("heading", { level: 1, name: "Data Engineer" })).toBeTruthy();
    expect(screen.getByText(/Full description of job 1\./)).toBeTruthy();
    // The list is still there, and the chat is tucked into a bubble.
    expect(
      within(screen.getByRole("list", { name: "Search results" })).getAllByRole("button"),
    ).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Open the assistant" })).toBeTruthy();

    fireEvent.click(
      within(screen.getByRole("list", { name: "Search results" })).getByText("Backend Engineer"),
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Backend Engineer" })).toBeTruthy();
    expect(screen.getByText(/Full description of job 3\./)).toBeTruthy();
  });

  it("shows the assistant's note on the open posting, and the bubble brings the chat back", async () => {
    await mount();
    const list = await screen.findByRole("list", { name: "Search results" });
    fireEvent.click(within(list).getByText("Platform Engineer"));
    expect(await screen.findByRole("region", { name: "Note from the assistant" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open the assistant" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Open the assistant" })).toBeNull(),
    );
    expect(screen.getByLabelText("Message the assistant")).toBeTruthy();
  });

  it("closes the posting with Escape", async () => {
    await mount();
    const list = await screen.findByRole("list", { name: "Search results" });
    fireEvent.click(within(list).getByText("Data Engineer"));
    await screen.findByRole("heading", { level: 1, name: "Data Engineer" });

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Open the assistant" })).toBeNull(),
    );
  });
});

describe("Assistant (mobile)", () => {
  beforeEach(() => stubBrowser(false));

  it("shows the list on its own tab and opens a posting full screen", async () => {
    await mount();
    fireEvent.click(await screen.findByRole("tab", { name: "Results" }));
    const list = await screen.findByRole("list", { name: "Search results" });

    fireEvent.click(within(list).getByText("Platform Engineer"));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Platform Engineer" }),
    ).toBeTruthy();
    expect(screen.getByText(/Full description of job 2\./)).toBeTruthy();
  });
});
