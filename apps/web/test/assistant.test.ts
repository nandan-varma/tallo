import type { JobAgentMessage, JobHit } from "@tallo/search-ai";
import { describe, expect, it } from "vitest";
import {
  activitiesOf,
  collectHits,
  currentSearch,
  notesById,
  postedLabel,
  textBlocks,
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
  locations: 1,
  ...over,
});

const assistant = (parts: unknown[]): JobAgentMessage =>
  ({ id: "a", role: "assistant", parts }) as unknown as JobAgentMessage;
const user = (text: string) =>
  ({ id: "u", role: "user", parts: [{ type: "text", text }] }) as unknown as JobAgentMessage;

const searched = (
  hits: JobHit[],
  queries = ["backend engineer"],
  locations?: string[],
  state = "output-available",
) => ({
  type: "tool-search_jobs",
  toolCallId: `s-${queries.join()}`,
  state,
  input: { queries, locations },
  output: { hits },
});
const noted = (notes: { id: string; why: string; evidence?: string[] }[]) => ({
  type: "tool-explain_jobs",
  toolCallId: "n",
  state: "output-available",
  input: { notes: [] },
  output: { notes: notes.map((n) => ({ evidence: [], ...n })), dropped: 0 },
});

describe("currentSearch", () => {
  it("is the last search that finished, wherever it was in the conversation", () => {
    const messages = [
      user("one"),
      assistant([searched([], ["old title"])]),
      user("two"),
      assistant([searched([], ["data engineer", "data analyst"], ["Seattle", "WA"])]),
      user("what do you mean"),
      assistant([{ type: "text", text: "Just chatting." }]),
    ];
    expect(currentSearch(messages)).toEqual({
      queries: ["data engineer", "data analyst"],
      locations: ["Seattle", "WA"],
    });
  });

  it("omits locations when there are none, and waits for a search to finish", () => {
    expect(currentSearch([assistant([searched([], ["a b"], [])])])).toEqual({ queries: ["a b"] });
    expect(
      currentSearch([assistant([searched([], ["a b"], undefined, "input-streaming")])]),
    ).toBeNull();
    expect(currentSearch([])).toBeNull();
  });

  it("carries the companies the person named into the list's search", () => {
    const part = {
      ...searched([], ["software engineer"]),
      input: { queries: ["software engineer"], companies: ["Stripe"] },
    };
    expect(currentSearch([assistant([part])])).toEqual({
      queries: ["software engineer"],
      companies: ["Stripe"],
    });
  });
});

describe("notesById / collectHits", () => {
  it("collects notes by job, later notes replace earlier ones", () => {
    const notes = notesById([
      assistant([
        noted([
          { id: "1", why: "first" },
          { id: "2", why: "two" },
        ]),
      ]),
      assistant([noted([{ id: "1", why: "second", evidence: ["q"] }])]),
    ]);
    expect([...notes.keys()].sort()).toEqual(["1", "2"]);
    expect(notes.get("1")).toEqual({ id: "1", why: "second", evidence: ["q"] });
  });

  it("ignores notes still being written", () => {
    const pending = assistant([
      { type: "tool-explain_jobs", toolCallId: "n", state: "input-streaming", input: {} },
    ]);
    expect(notesById([pending]).size).toBe(0);
  });

  it("gathers hits across searches; the newest wins for an id", () => {
    const hits = collectHits([
      assistant([searched([hit("1"), hit("2")])]),
      assistant([searched([hit("2", { title: "Newer" })])]),
    ]);
    expect([...hits.keys()].sort()).toEqual(["1", "2"]);
    expect(hits.get("2")?.title).toBe("Newer");
  });
});

describe("activitiesOf", () => {
  const hits = new Map([["7", hit("7", { title: "Staff Engineer", company: "Grafana" })]]);

  it("describes a turn: a search with places, a read in full, notes", () => {
    const message = assistant([
      searched([hit("7")], ["backend engineer", "platform engineer"], ["Seattle"]),
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
      noted([{ id: "7", why: "Pays well." }]),
    ]);
    expect(activitiesOf(message, hits)).toEqual([
      {
        key: "s-backend engineer,platform engineer",
        tool: "search",
        state: "done",
        label: "Found 1 role",
        detail: "backend engineer · platform engineer in Seattle",
      },
      {
        key: "d",
        tool: "read",
        state: "done",
        label: "Read Staff Engineer · Grafana",
        detail: "9,303 characters, in full",
      },
      { key: "n", tool: "note", state: "done", label: "Added 1 note" },
    ]);
  });

  it("describes work in progress and errors", () => {
    const message = assistant([
      { type: "tool-search_jobs", toolCallId: "a", state: "input-streaming", input: undefined },
      { type: "tool-read_job", toolCallId: "b", state: "input-available", input: { id: "7" } },
      {
        type: "tool-explain_jobs",
        toolCallId: "c",
        state: "output-error",
        input: { notes: [] },
        errorText: "x",
      },
    ]);
    const [search, read, note] = activitiesOf(message, hits);
    expect(search).toMatchObject({ state: "running", label: "Searching" });
    expect(read).toMatchObject({ state: "running", label: "Reading Staff Engineer · Grafana" });
    expect(note).toMatchObject({ state: "error" });
  });
});

describe("text", () => {
  it("joins text parts as paragraphs and marks narration before the last tool call", () => {
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

describe("postedLabel", () => {
  it("says how long ago", () => {
    const now = Date.parse("2026-10-26");
    expect(postedLabel("2026-10-26", now)).toBe("today");
    expect(postedLabel("2026-10-23", now)).toBe("3d ago");
    expect(postedLabel("2026-08-20", now)).toBe("2mo ago");
    expect(postedLabel(null, now)).toBeNull();
    expect(postedLabel("nonsense", now)).toBeNull();
  });
});
