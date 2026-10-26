import type { JobAgentMessage, JobHit } from "@tallo/search-ai";
import { describe, expect, it } from "vitest";
import {
  activitiesOf,
  collectHits,
  latestRanking,
  latestSearch,
  textOf,
} from "../src/lib/assistant.ts";

const hit = (id: string, over: Partial<JobHit> = {}): JobHit => ({
  id,
  title: `Engineer ${id}`,
  company: "Acme",
  location: "Remote, US",
  workMode: "remote",
  pay: null,
  postedAt: null,
  department: null,
  ...over,
});

const assistant = (parts: unknown[]): JobAgentMessage =>
  ({ id: "a", role: "assistant", parts }) as unknown as JobAgentMessage;

const searched = (hits: JobHit[], queries = ["backend engineer"]) => ({
  type: "tool-search_jobs",
  toolCallId: "s1",
  state: "output-available",
  input: { queries },
  output: { hits },
});

const match = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  verdict: "strong",
  fit: 80,
  reason: `reason ${id}`,
  evidence: [],
  unknowns: [],
  ...over,
});

describe("collectHits / latestSearch", () => {
  it("gathers hits across searches; the newest wins for an id", () => {
    const messages = [
      assistant([searched([hit("1"), hit("2")])]),
      assistant([searched([hit("2", { title: "Newer" }), hit("3")])]),
    ];
    const hits = collectHits(messages);
    expect([...hits.keys()].sort()).toEqual(["1", "2", "3"]);
    expect(hits.get("2")?.title).toBe("Newer");
    expect(latestSearch(messages).map((h) => h.id)).toEqual(["2", "3"]);
  });

  it("ignores searches still running", () => {
    const running = assistant([
      {
        type: "tool-search_jobs",
        toolCallId: "s",
        state: "input-available",
        input: { queries: ["x"] },
      },
    ]);
    expect(collectHits([running]).size).toBe(0);
    expect(latestSearch([running])).toEqual([]);
  });
});

describe("latestRanking", () => {
  const hits = new Map([
    ["1", hit("1")],
    ["2", hit("2")],
  ]);

  it("is empty before any ranking", () => {
    expect(latestRanking([assistant([{ type: "text", text: "hi" }])], hits)).toEqual({
      state: "none",
      matches: [],
    });
  });

  it("shows cards while show_jobs streams, skipping entries whose id is missing or not a known job yet", () => {
    const streaming = assistant([
      {
        type: "tool-show_jobs",
        toolCallId: "r",
        state: "input-streaming",
        input: {
          matches: [
            match("1", { evidence: ["quote", undefined] }),
            { reason: "no id yet" },
            { id: "99", reason: "id still streaming, not a known job" },
          ],
        },
      },
    ]);
    const ranking = latestRanking([streaming], hits);
    expect(ranking.state).toBe("ranking");
    expect(ranking.matches).toHaveLength(1);
    expect(ranking.matches[0]).toMatchObject({
      id: "1",
      reason: "reason 1",
      evidence: ["quote"],
      hit: { title: "Engineer 1" },
    });
  });

  it("prefers the checked output when finished, and the newest ranking wins", () => {
    const first = assistant([
      {
        type: "tool-show_jobs",
        toolCallId: "r1",
        state: "output-available",
        input: { matches: [] },
        output: { matches: [match("1")], droppedEvidence: 0 },
      },
    ]);
    const second = assistant([
      {
        type: "tool-show_jobs",
        toolCallId: "r2",
        state: "output-available",
        input: { matches: [] },
        output: { matches: [match("2"), match("9")], droppedEvidence: 1 },
      },
    ]);
    const ranking = latestRanking([first, second], hits);
    expect(ranking.state).toBe("done");
    expect(ranking.matches.map((m) => m.id)).toEqual(["2", "9"]);
    expect(ranking.matches[1]?.hit).toBeUndefined();
  });

  it("falls back to an older ranking when the newest call errored", () => {
    const ok = assistant([
      {
        type: "tool-show_jobs",
        toolCallId: "r1",
        state: "output-available",
        input: { matches: [] },
        output: { matches: [match("1")], droppedEvidence: 0 },
      },
    ]);
    const failed = assistant([
      {
        type: "tool-show_jobs",
        toolCallId: "r2",
        state: "output-error",
        input: { matches: [] },
        errorText: "boom",
      },
    ]);
    expect(latestRanking([ok, failed], hits).matches.map((m) => m.id)).toEqual(["1"]);
  });
});

describe("activitiesOf", () => {
  const hits = new Map([["7", hit("7", { title: "Staff Engineer", company: "Grafana" })]]);

  it("describes a turn: search, a read in full, a ranking", () => {
    const message = assistant([
      searched([hit("7")], ["backend engineer", "platform engineer"]),
      {
        type: "tool-read_job",
        toolCallId: "d",
        state: "output-available",
        input: { id: "7" },
        output: {
          found: true,
          id: "7",
          title: "Staff Engineer",
          company: "Grafana",
          chars: 9303,
          facts: {},
        },
      },
      {
        type: "tool-show_jobs",
        toolCallId: "r",
        state: "output-available",
        input: { matches: [] },
        output: { matches: [match("7")], droppedEvidence: 0 },
      },
    ]);
    expect(activitiesOf(message, hits)).toEqual([
      {
        key: "s1",
        tool: "search",
        state: "done",
        label: "Found 1 role",
        detail: "backend engineer · platform engineer",
      },
      {
        key: "d",
        tool: "read",
        state: "done",
        label: "Read Staff Engineer · Grafana",
        detail: "9,303 characters, in full",
      },
      { key: "r", tool: "rank", state: "done", label: "Ranked 1 match" },
    ]);
  });

  it("describes work in progress and errors", () => {
    const message = assistant([
      { type: "tool-search_jobs", toolCallId: "a", state: "input-streaming", input: undefined },
      { type: "tool-read_job", toolCallId: "b", state: "input-available", input: { id: "7" } },
      {
        type: "tool-show_jobs",
        toolCallId: "c",
        state: "output-error",
        input: { matches: [] },
        errorText: "x",
      },
    ]);
    const [search, read, rank] = activitiesOf(message, hits);
    expect(search).toMatchObject({ state: "running", label: "Searching" });
    expect(read).toMatchObject({ state: "running", label: "Reading Staff Engineer · Grafana" });
    expect(rank).toMatchObject({ state: "error" });
  });

  it("says nothing fits for an empty ranking", () => {
    const message = assistant([
      {
        type: "tool-show_jobs",
        toolCallId: "r",
        state: "output-available",
        input: { matches: [] },
        output: { matches: [], droppedEvidence: 0 },
      },
    ]);
    expect(activitiesOf(message, hits)[0]?.label).toBe("Nothing fits well");
  });
});

describe("textOf", () => {
  it("joins text parts and ignores tool parts", () => {
    const message = assistant([
      { type: "text", text: "One. " },
      searched([]),
      { type: "text", text: "Two." },
    ]);
    expect(textOf(message)).toBe("One.\n\nTwo.");
  });
});

import { markQuotes, payLabel, postedLabel } from "../src/lib/assistant.ts";

describe("payLabel / postedLabel", () => {
  it("formats the API's pay text and passes unknown shapes through", () => {
    expect(payLabel("USD 150000-180000 per year")).toBe("$150K – $180K / yr");
    expect(payLabel("200000-200000 per year")).toBe("$200K / yr");
    expect(payLabel("negotiable")).toBe("negotiable");
    expect(payLabel(null)).toBeNull();
  });

  it("says how long ago", () => {
    const now = Date.parse("2026-10-26");
    expect(postedLabel("2026-10-26", now)).toBe("today");
    expect(postedLabel("2026-10-23", now)).toBe("3d ago");
    expect(postedLabel("2026-08-20", now)).toBe("2mo ago");
    expect(postedLabel(null, now)).toBeNull();
    expect(postedLabel("nonsense", now)).toBeNull();
  });
});

describe("markQuotes", () => {
  const text = "Intro.\nSalary: $190,000 - $220,000\nper year.\nMinimum 5 years of TypeScript.";

  it("marks quotes even when whitespace differs, keeping every character of the text", () => {
    const segments = markQuotes(text, [
      "Salary: $190,000 - $220,000 per year.",
      "minimum 5 years of typescript.",
    ]);
    expect(segments.map((s) => s.text).join("")).toBe(text);
    expect(segments.filter((s) => s.quote !== undefined).map((s) => s.quote)).toEqual([0, 1]);
    expect(segments.find((s) => s.quote === 0)?.text).toBe(
      "Salary: $190,000 - $220,000\nper year.",
    );
  });

  it("skips quotes that are absent or overlap an earlier one", () => {
    const segments = markQuotes(text, [
      "not in the text",
      "Minimum 5 years",
      "5 years of TypeScript",
    ]);
    expect(segments.filter((s) => s.quote !== undefined)).toHaveLength(1);
    expect(segments.map((s) => s.text).join("")).toBe(text);
  });

  it("is a single plain segment with no quotes", () => {
    expect(markQuotes("hello", [])).toEqual([{ text: "hello" }]);
    expect(markQuotes("", ["x"])).toEqual([]);
  });
});

import { textBlocks } from "../src/lib/assistant.ts";

describe("textBlocks", () => {
  it("separates paragraphs and marks the text before the last tool call as narration", () => {
    const message = assistant([
      { type: "text", text: "Let me search. " },
      searched([]),
      { type: "text", text: "  " },
      { type: "text", text: "Here is what I found." },
    ]);
    expect(textBlocks(message)).toEqual([
      { text: "Let me search.", narration: true },
      { text: "Here is what I found.", narration: false },
    ]);
    expect(textOf(message)).toBe("Let me search.\n\nHere is what I found.");
  });
});
