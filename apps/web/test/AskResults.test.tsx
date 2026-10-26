import type { Item, SearchResult, Trace } from "@tallo/search-ai";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AskResults } from "../src/components/AskResults.tsx";

const item = (overrides: Partial<Item> = {}): Item => ({
  rank: 1,
  id: "42",
  title: "Backend Engineer",
  company: "Acme",
  locations: ["Remote, US", "Austin, TX"],
  verdict: "strong",
  fit: 88.4,
  reason: "Go and Postgres match the profile.",
  evidence: ["Experience with Go and PostgreSQL"],
  unknowns: ["Salary range"],
  ...overrides,
});

const trace = {
  understand: { titles: ["Backend Engineer"], queries: ["go"] },
  recall: { queries: 1, candidates: 120 },
  triage: { batches: 2, strong: 3, maybe: 9, no: 108, defaulted: 0, decisions: [] },
  deep: {
    reads: 2,
    descriptionChars: 9000,
    chunks: 2,
    emptyDescriptions: 0,
    droppedEvidence: 1,
    scored: [],
  },
  answer: { items: 1 },
  tokens: { fast: { input: 100, output: 20 }, smart: { input: 300, output: 40 } },
  retries: 0,
} satisfies Trace;

const render = (items: Item[], elapsedSeconds?: number) => {
  const result: SearchResult = { answer: { query: "go", items }, trace };
  return renderToStaticMarkup(<AskResults result={result} elapsedSeconds={elapsedSeconds} />);
};

describe("AskResults", () => {
  it("shows an honest empty state instead of weak matches", () => {
    const html = render([]);
    expect(html).toContain("No good matches");
    expect(html).not.toContain("<ol");
  });

  it("renders a linked title, verdict, rounded fit, reason, evidence and unknowns", () => {
    const html = render([item()]);
    expect(html).toContain('href="/jobs/42"');
    expect(html).toContain(">Backend Engineer</a>");
    expect(html).toContain("Strong fit");
    expect(html).toContain("· 88");
    expect(html).toContain("Go and Postgres match the profile.");
    expect(html).toContain("Experience with Go and PostgreSQL");
    expect(html).toContain("Salary range");
    expect(html).toContain("Acme");
    expect(html).toContain("Remote, US · Austin, TX");
  });

  it("omits the fit number and the unknown list when the engine did not report them", () => {
    const html = render([item({ fit: null, unknowns: [], evidence: [], verdict: "maybe" })]);
    expect(html).toContain("Possible fit");
    expect(html).not.toContain("· 88");
    expect(html).not.toContain(">Unknown<");
    expect(html).not.toContain(">Evidence<");
  });

  it("does not link a non-numeric id", () => {
    const html = render([item({ id: "abc" })]);
    expect(html).not.toContain("/jobs/abc");
    expect(html).toContain("Backend Engineer");
  });

  it("renders items in rank order", () => {
    const html = render([
      item({ rank: 2, title: "Second role", id: "2" }),
      item({ rank: 1, title: "First role", id: "1" }),
    ]);
    expect(html.indexOf("First role")).toBeLessThan(html.indexOf("Second role"));
  });

  it("renders the trace collapsed with the reported counts and the measured round trip", () => {
    const html = render([item()], 12.6);
    expect(html).toContain("<details");
    expect(html).toContain(">Trace</summary>");
    expect(html).toContain("9,000");
    expect(html).toContain("Round trip, measured in browser (s)");
    expect(html).toContain(">13<");
  });
});
