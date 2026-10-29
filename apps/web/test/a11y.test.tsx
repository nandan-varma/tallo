// @vitest-environment jsdom
import {
  type Application,
  defaultResumeDoc,
  type Resume,
  type ResumeRecord,
} from "@tallo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { expectNoViolations } from "./a11y.ts";

// The PDF engine is covered elsewhere; here it is a stub, as in ResumeWorkspace.test.tsx.
vi.mock("@/components/resume/PdfPreview", () => ({
  usePreview: (_doc: unknown, enabled: boolean) => ({
    rendered: enabled
      ? {
          pdf: new Uint8Array([1]),
          pages: 1,
          fits: true,
          density: { font: 10.5, line: 1.3, margin: 40, gap: 9 },
        }
      : null,
    busy: false,
    error: null,
  }),
  PdfPages: () => <div data-testid="pdf" />,
}));

import { AboutSheet } from "@/components/assistant/AboutSheet";
import { Assistant } from "@/components/assistant/Assistant";
import { JobList } from "@/components/assistant/JobList";
import { Editor } from "@/components/resume/Editor";
import { ResumeWorkspace } from "@/components/resume/ResumeWorkspace";
import { ThemeToggle } from "@/components/ThemeToggle";

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
  pay: "USD 150000-180000 per year",
  department: null,
  employmentType: "full-time",
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

const app = (jobId: number, status: Application["status"], note = ""): Application => ({
  jobId,
  status,
  note,
  title: DB_HITS[jobId - 1]?.title ?? `Role ${jobId}`,
  company: `Company ${jobId}`,
  location: "Seattle, WA",
  applyUrl: `https://example.com/apply/${jobId}`,
  createdAt: 1,
  updatedAt: 1,
  appliedAt: null,
});

let copies: { jobId: number | null }[] = [];
let tracked: Application[] = [];
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
      if (url === "/api/search") return Response.json({ hits: DB_HITS, nextOffset: null });
      if (url === "/api/resumes") return Response.json(copies);
      if (url === "/api/applications") return Response.json(tracked);
      if (url === "/api/searches" && init?.method === "GET") return Response.json(saved);
      if (url.startsWith("/api/searches")) return Response.json({});
      const job = /\/api\/jobs\/(\d+)\.json/.exec(url)?.[1];
      if (job) return Response.json(detail(Number(job)));
      if (url === "/api/profile") {
        return Response.json(
          init?.method === "PUT"
            ? { ok: true }
            : { profile: "Remote or Boston.", resume: "", updatedAt: 1 },
        );
      }
      throw new Error(`unexpected fetch ${url} ${init?.method ?? "GET"}`);
    }),
  );
}

function withQuery(children: ReactNode) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
}

function fullResume(): Resume {
  return {
    name: "Ada Lovelace",
    headline: "Platform Engineer",
    email: "ada@example.com",
    phone: "+1 555 0100",
    location: "Seattle, WA",
    links: [{ label: "GitHub", url: "https://github.com/ada" }],
    summary: "Builds data platforms for small teams.",
    experience: [
      {
        company: "Acme",
        title: "Engineer",
        location: "Remote",
        start: "2020",
        end: "Present",
        bullets: ["Built the ingest pipeline.", "Cut query time by half."],
      },
    ],
    education: [
      {
        school: "State University",
        degree: "BSc Computer Science",
        location: "Seattle, WA",
        start: "2014",
        end: "2018",
        details: ["Dean's list"],
      },
    ],
    skills: [{ label: "Languages", items: ["TypeScript", "Go"] }],
    projects: [
      {
        name: "Open ledger",
        url: "https://example.com/ledger",
        bullets: ["Double-entry bookkeeping library."],
      },
    ],
    extras: [{ title: "Certifications", items: ["AWS Solutions Architect"] }],
  };
}

const record = (jobId: number | null): ResumeRecord => {
  const doc = defaultResumeDoc();
  doc.resume = fullResume();
  return { jobId, doc, updatedAt: 1 };
};

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

describe("accessibility: assistant (desktop)", () => {
  beforeEach(() => stubBrowser(true));

  it("the finished conversation with the tracker open", async () => {
    tracked = [app(1, "saved", "Ask about on-call"), app(2, "applied")];
    const view = render(<Assistant hasResume={false} initialJob={null} />);
    await screen.findByRole("list", { name: "Search results" });
    const trackerTab = await screen.findByRole("tab", { name: /^Tracker 2$/ });
    fireEvent.click(trackerTab);
    await screen.findByRole("list", { name: "Tracked roles" });
    await expectNoViolations(view.container);
  });

  it("an open posting, opened from a result", async () => {
    const view = render(<Assistant hasResume={false} initialJob={null} />);
    const list = await screen.findByRole("list", { name: "Search results" });
    fireEvent.click(within(list).getByText("Data Engineer"));
    await screen.findByRole("heading", { level: 1, name: "Data Engineer" });
    await waitFor(() => screen.getByText(/Full description of job 1\./));
    await expectNoViolations(view.container);
  });
});

describe("accessibility: resume", () => {
  beforeEach(() => stubBrowser(true));

  it("the editor with every section filled", async () => {
    function Harness() {
      const [resume, setResume] = useState(fullResume);
      return <Editor resume={resume} onResume={(change) => setResume((r) => change(r))} />;
    }
    const view = render(<Harness />);
    await expectNoViolations(view.container);
  });

  it("the workspace for a posting's copy, on the cover letter tab", async () => {
    const view = render(
      <ResumeWorkspace
        initial={record(5)}
        base={null}
        posting={{
          id: 5,
          title: "Platform Engineer",
          company: "Globex",
          applyUrl: "https://globex.example/apply",
        }}
        copies={[]}
        autoTailor={false}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Cover letter" }));
    await screen.findByLabelText("Cover letter text");
    await expectNoViolations(view.container);
  });

  it("the import panel on first run", async () => {
    const view = render(
      <ResumeWorkspace initial={null} base={null} posting={null} copies={[]} autoTailor={false} />,
    );
    await screen.findByRole("heading", { name: "Build your resume" });
    await expectNoViolations(view.container);
  });
});

describe("accessibility: sheets, toggles and menus", () => {
  beforeEach(() => stubBrowser(true));

  it("the about-you sheet", async () => {
    render(withQuery(<AboutSheet hasResume />));
    fireEvent.click(screen.getByRole("button", { name: "About you" }));
    await screen.findByLabelText(/Target roles/);
    // The sheet is portalled to the body, so the whole document is the scope.
    await expectNoViolations(document.body);
  });

  it("the theme toggle", async () => {
    const view = render(<ThemeToggle />);
    await expectNoViolations(view.container);
  });

  it("the status menu open on a tracked role", async () => {
    tracked = [app(1, "saved", "Ask about on-call")];
    render(
      withQuery(
        <JobList
          spec={null}
          notes={new Map()}
          view="tracker"
          onView={() => {}}
          openId={null}
          working={false}
          started={false}
          onOpen={() => {}}
        />,
      ),
    );
    await screen.findByRole("list", { name: "Tracked roles" });
    fireEvent.pointerDown(screen.getByRole("button", { name: /Status: Saved/ }), {
      button: 0,
      ctrlKey: false,
    });
    await screen.findByRole("menuitem", { name: "Interviewing" });
    await expectNoViolations(document.body);
  });
});
