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
      {
        type: "tool-publish_jobs",
        toolCallId: "p1",
        state: "output-available",
        input: { search: { queries: ["data engineer"], locations: ["Seattle", "WA"] }, jobs: [] },
        output: {
          search: { queries: ["data engineer"], locations: ["Seattle", "WA"] },
          hits: DB_HITS,
          notes: [],
          dropped: 0,
        },
      },
      { type: "text", text: "I searched Seattle and the rest of Washington." },
    ],
  },
];

let chatMessages: unknown[] = conversation;

vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: chatMessages,
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
  pay: null,
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

let copies: { jobId: number | null }[] = [];
let tracked: unknown[] = [];
let saved: unknown[] = [];

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
        return Response.json({ hits: DB_HITS, nextOffset: null });
      }
      if (url === "/api/resumes") return Response.json(copies);
      if (url === "/api/applications") return Response.json(tracked);
      if (url === "/api/searches" && init?.method === "GET") return Response.json(saved);
      if (url.startsWith("/api/searches")) return Response.json({});
      const job = /\/api\/jobs\/(\d+)\.json/.exec(url)?.[1];
      if (job) return Response.json(detail(Number(job)));
      throw new Error(`unexpected fetch ${url} ${init?.method ?? "GET"}`);
    }),
  );
}

async function mountEmpty() {
  chatMessages = [];
  return mount();
}

async function mount(initialJob: string | null = null) {
  const { Assistant } = await import("../src/components/assistant/Assistant.tsx");
  return render(<Assistant hasResume={false} initialJob={initialJob} />);
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  copies = [];
  tracked = [];
  saved = [];
  chatMessages = conversation;
  history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Assistant (desktop)", () => {
  beforeEach(() => stubBrowser(true));

  it("lists published recommendations without fetching broad candidates, with their notes", async () => {
    await mount();
    const list = await screen.findByRole("list", { name: "Search results" });
    expect(within(list).getAllByRole("button")).toHaveLength(3);
    expect(within(list).getByText("Closest to your platform background.")).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/search")).toBe(false);
  });

  it("does not expose senior candidates that were not selected for an early-career request", async () => {
    const junior = hit(1, "Graduate Software Engineer");
    const senior = hit(2, "Senior Software Engineer");
    chatMessages = [
      { id: "u", role: "user", parts: [{ type: "text", text: "early career software" }] },
      {
        id: "a",
        role: "assistant",
        parts: [
          {
            type: "tool-search_jobs",
            toolCallId: "s",
            state: "output-available",
            input: { queries: ["software engineer"] },
            output: { hits: [junior, senior] },
          },
          {
            type: "tool-publish_jobs",
            toolCallId: "p",
            state: "output-available",
            input: {
              search: { queries: ["data engineer"], locations: ["Seattle", "WA"] },
              jobs: [],
            },
            output: {
              search: { queries: ["software engineer"] },
              hits: [junior],
              notes: [],
              dropped: 0,
            },
          },
        ],
      },
    ];
    await mount();
    const list = await screen.findByRole("list", { name: "Search results" });
    expect(within(list).getByText("Graduate Software Engineer")).toBeTruthy();
    expect(within(list).queryByText("Senior Software Engineer")).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/search")).toBe(false);
  });

  it("does not restore old recommendations after a new user request or an unfinished legacy search", async () => {
    chatMessages = [
      ...conversation,
      { id: "u2", role: "user", parts: [{ type: "text", text: "only remote" }] },
    ];
    const view = await mount();
    expect(screen.queryByRole("list", { name: "Search results" })).toBeNull();
    expect(screen.getByText("Results appear here")).toBeTruthy();
    view.unmount();
    chatMessages = [
      conversation[0],
      { id: "legacy", role: "assistant", parts: [conversation[1]?.parts[0]] },
    ];
    await mount();
    expect(screen.queryByRole("list", { name: "Search results" })).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/search")).toBe(false);
  });

  it("shows an empty reviewed selection without broad-result fallback", async () => {
    chatMessages = [
      conversation[0],
      {
        id: "a",
        role: "assistant",
        parts: [
          {
            type: "tool-publish_jobs",
            toolCallId: "p",
            state: "output-available",
            input: {
              search: { queries: ["data engineer"], locations: ["Seattle", "WA"] },
              jobs: [],
            },
            output: { search: { queries: ["software engineer"] }, hits: [], notes: [], dropped: 0 },
          },
        ],
      },
    ];
    await mount();
    expect(screen.getByText("No reviewed matches yet")).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/search")).toBe(false);
  });

  it("pages published results locally without requesting unreviewed jobs", async () => {
    const hits = Array.from({ length: 25 }, (_, i) => hit(i + 1, `Reviewed Engineer ${i + 1}`));
    chatMessages = [
      conversation[0],
      {
        id: "a",
        role: "assistant",
        parts: [
          {
            type: "tool-publish_jobs",
            toolCallId: "p",
            state: "output-available",
            input: {
              search: { queries: ["data engineer"], locations: ["Seattle", "WA"] },
              jobs: [],
            },
            output: { search: { queries: ["software engineer"] }, hits, notes: [], dropped: 0 },
          },
        ],
      },
    ];
    await mount();
    let list = await screen.findByRole("list", { name: "Search results" });
    expect(within(list).getAllByRole("button")).toHaveLength(20);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    list = screen.getByRole("list", { name: "Search results" });
    expect(within(list).getAllByRole("button")).toHaveLength(5);
    expect(within(list).getByText("Reviewed Engineer 21")).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/search")).toBe(false);
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

  it("keeps the open posting in the address, and opens one from the address", async () => {
    const view = await mount();
    const list = await screen.findByRole("list", { name: "Search results" });
    fireEvent.click(within(list).getByText("Data Engineer"));
    await screen.findByRole("heading", { level: 1, name: "Data Engineer" });
    expect(location.search).toBe("?job=1");

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(location.search).toBe(""));

    view.unmount();
    await mount("3");
    expect(await screen.findByRole("heading", { level: 1, name: "Backend Engineer" })).toBeTruthy();
  });

  it("offers to tailor the resume for a posting, or to open the copy that exists", async () => {
    const view = await mount("1");
    const tailor = await screen.findByRole("link", { name: "Tailor resume" });
    expect(tailor.getAttribute("href")).toBe("/resume/1?tailor=1");

    view.unmount();
    copies = [{ jobId: 1 }];
    await mount("1");
    const open = await screen.findByRole("link", { name: "Your resume" });
    expect(open.getAttribute("href")).toBe("/resume/1");
  });

  it("saves canonical Washington constraints rather than the last locationless exploration", async () => {
    const search = { queries: ["data engineer"], locations: ["Seattle", "WA"] };
    chatMessages = [
      conversation[0],
      {
        id: "a",
        role: "assistant",
        parts: [
          {
            type: "tool-search_jobs",
            toolCallId: "s",
            state: "output-available",
            input: { queries: ["data engineer"] },
            output: { hits: DB_HITS },
          },
          {
            type: "tool-publish_jobs",
            toolCallId: "p",
            state: "output-available",
            input: { search, jobs: [] },
            output: { search, hits: DB_HITS, notes: [], dropped: 0 },
          },
        ],
      },
    ];
    await mount();
    await screen.findByRole("list", { name: "Search results" });
    fireEvent.click(screen.getByRole("button", { name: "Save this search" }));
    await waitFor(() => {
      const post = vi
        .mocked(fetch)
        .mock.calls.find(([url, init]) => url === "/api/searches" && init?.method === "POST");
      expect(JSON.parse(String((post?.[1] as RequestInit | undefined)?.body))).toEqual({
        name: "Data Engineer · Seattle",
        spec: { queries: ["data engineer"], locations: ["Seattle", "WA"] },
      });
    });
  });

  it("opens a saved search from the empty chat and marks it seen", async () => {
    saved = [
      {
        id: 4,
        name: "Backend · Boston",
        spec: { queries: ["backend engineer"], locations: ["Boston"] },
        createdAt: 1,
        seenAt: 1,
        newCount: 3,
        newCapped: false,
      },
    ];
    await mountEmpty();
    const card = await screen.findByRole("button", { name: /^Backend · Boston/ });
    expect(within(card).getByText("3 new")).toBeTruthy();
    fireEvent.click(card);
    await waitFor(() => {
      const seen = vi
        .mocked(fetch)
        .mock.calls.find(
          ([url, init]) => url === "/api/searches/4/seen" && init?.method === "POST",
        );
      expect(seen).toBeDefined();
    });
    expect(screen.getByText(/broad catalog matches, not reviewed/)).toBeTruthy();
    const search = vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/search");
    expect(JSON.parse(String((search?.[1] as RequestInit | undefined)?.body))).toMatchObject({
      queries: ["backend engineer"],
      locations: ["Boston"],
    });
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
    const views = await screen.findByRole("tablist", { name: "View" });
    fireEvent.click(within(views).getByRole("tab", { name: "Results" }));
    const list = await screen.findByRole("list", { name: "Search results" });

    fireEvent.click(within(list).getByText("Platform Engineer"));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Platform Engineer" }),
    ).toBeTruthy();
    expect(screen.getByText(/Full description of job 2\./)).toBeTruthy();
  });
});
