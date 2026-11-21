import { readFileSync } from "node:fs";
import { createApp } from "@tallo/api/app";
import type { SourceConfig } from "@tallo/contracts";
import { memoryBlobs, schema } from "@tallo/db";
import { testDb } from "@tallo/db/testing";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api.ts";
import { syncSource } from "../src/sync.ts";

/**
 * Issue #140: a posting whose detail fetch failed must be fetched again by the next sync, on every
 * platform that has a detail step. The mechanism is generic (collect/engine.ts + ingest.ts): a posting
 * whose detail throws is never applied, so its stored `source_hash` does not advance, and the next
 * diff lists it as changed. These tests pin that with the real runner, the real test database and a
 * fake fetch built from the recorded platform fixtures. No network.
 */

const PLATFORM_FIXTURES = new URL("../../../packages/platforms/test/fixtures/", import.meta.url);
const fixtureText = (name: string) => readFileSync(new URL(name, PLATFORM_FIXTURES), "utf8");
const log = pino({ level: "silent" });

const BOOTSTRAP = `<html><body>
<script>require("LSD")</script>
<script type="application/json">{"require":[[["LSD",[],{"token":"tok-fixture"},1],["SiteData",[],{"server_revision":1,"haste_session":"hs-fixture","pr":1,"client_revision":1,"hsi":"hsi-fixture","comet_env":31,"__spin_r":1,"__spin_b":"trunk","__spin_t":1},1]]]}</script>
</body></html>`;

type Answer =
  | { kind: "list"; body: string }
  | { kind: "detail"; id: string; body: string }
  | { kind: "other"; body: string };

interface Board {
  name: string;
  source: SourceConfig;
  /** Posting ids in listing order. */
  postings: string[];
  /** Answers one request. `renamed` changes the first listed posting's title, so its listing hash moves. */
  answer(url: URL, renamed: boolean): Answer;
}

const json = (name: string, edit?: (value: Record<string, unknown>) => void) => {
  const value = JSON.parse(fixtureText(`${name}.json`)) as Record<string, unknown>;
  edit?.(value);
  return JSON.stringify(value);
};

const netflix: Board = {
  name: "Netflix",
  source: {
    id: "netflix:netflix.com",
    platform: "netflix",
    key: "netflix.com",
    company: "Netflix",
    params: {},
  },
  postings: ["790298014263", "790319610169"],
  answer(url, renamed) {
    const path = url.pathname;
    if (path === "/api/apply/v2/jobs")
      return {
        kind: "list",
        body: json("netflix-list", (value) => {
          if (renamed) (value.positions as Record<string, unknown>[])[0]!.name = "Renamed role";
        }),
      };
    const id = decodeURIComponent(path.slice("/api/apply/v2/jobs/".length));
    return { kind: "detail", id, body: fixtureText("netflix-detail-onsite.json") };
  },
};

const apple: Board = {
  name: "Apple",
  source: { id: "apple:careers", platform: "apple", key: "careers", company: "Apple", params: {} },
  postings: ["PIPE-114438346", "PIPE-114438210"],
  answer(url, renamed) {
    const path = url.pathname;
    if (path === "/api/v1/search")
      return {
        kind: "list",
        body: json("apple-list", (value) => {
          const results = (value.res as { searchResults: Record<string, unknown>[] }).searchResults;
          if (renamed) results[0]!.postingTitle = "Renamed role";
        }),
      };
    const id = decodeURIComponent(path.slice("/api/v1/jobDetails/".length));
    return { kind: "detail", id, body: fixtureText("apple-detail.json") };
  },
};

const meta: Board = {
  name: "Meta",
  source: { id: "meta:meta", platform: "meta", key: "meta", company: "Meta", params: {} },
  // The recorded job page answers for the first search row only.
  postings: ["2486789151677735"],
  answer(url, renamed) {
    if (url.pathname === "/jobsearch/") return { kind: "other", body: BOOTSTRAP };
    if (url.pathname === "/api/graphql/") {
      const search = JSON.parse(fixtureText("meta-list.json")) as {
        data: { job_search_with_featured_jobs_v2: { all_jobs: Record<string, unknown>[] } };
      };
      const root = search.data.job_search_with_featured_jobs_v2;
      const first = { ...root.all_jobs[0]! };
      if (renamed) first.title = "Renamed role";
      return {
        kind: "list",
        body: JSON.stringify({
          data: { job_search_with_featured_jobs_v2: { all_jobs: [first], featured_jobs: [] } },
        }),
      };
    }
    const id = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
    return { kind: "detail", id, body: fixtureText("meta-detail.html") };
  },
};

const boards = [netflix, apple, meta];

/**
 * Fake fetch for one board. Detail requests for ids in `failing` answer 404 (a non-retried HTTP error, which
 * is what a failed detail looks like to the engine). Every detail request is recorded in `detailCalls`.
 */
function serve(
  board: Board,
  state: { failing: Set<string>; renamed: boolean; detailCalls: string[] },
) {
  const fetchFn: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const answer = board.answer(url, state.renamed);
    if (answer.kind === "detail") {
      state.detailCalls.push(answer.id);
      if (state.failing.has(answer.id)) return new Response("unavailable", { status: 404 });
    }
    return new Response(answer.body, { status: 200 });
  };
  return fetchFn;
}

function stack() {
  const db = testDb();
  const blobs = memoryBlobs();
  const app = createApp({ db, blobs, ingestToken: "i" });
  const api = createApi("https://api.test", "i", async (req) =>
    app.fetch(req instanceof Request ? req : new Request(req)),
  );
  return { db, api };
}

describe.each(boards)(
  "$name: a failed detail is fetched again by the next sync (#140)",
  (board) => {
    it("keeps the failed posting out of the catalog and fetches only it on the next sync", async () => {
      const { db, api } = stack();
      const [failId, ...others] = board.postings as [string, ...string[]];
      const state = { failing: new Set([failId]), renamed: false, detailCalls: [] as string[] };
      const run = () =>
        syncSource(board.source, {
          api,
          log,
          runnerId: "test",
          version: "t",
          fetch: serve(board, state),
        });

      const first = await run();
      expect(first).toMatchObject({
        listingComplete: true,
        detailsComplete: false,
        changed: board.postings.length,
      });
      expect(first.issues.filter((i) => i.code === "detail").map((i) => i.postingId)).toEqual([
        failId,
      ]);
      expect(await storedPostingIds(db)).toEqual([...others].sort());

      state.failing.clear();
      state.detailCalls.length = 0;
      const second = await run();
      expect(second).toMatchObject({ listingComplete: true, detailsComplete: true, changed: 1 });
      expect(state.detailCalls).toEqual([failId]);
      expect(await storedPostingIds(db)).toEqual([...board.postings].sort());
    });

    it("a failed detail on a changed posting keeps the stored hash, leaves it open, and is re-fetched", async () => {
      const { db, api } = stack();
      const [changedId] = board.postings as [string, ...string[]];
      const state = { failing: new Set<string>(), renamed: false, detailCalls: [] as string[] };
      const run = () =>
        syncSource(board.source, {
          api,
          log,
          runnerId: "test",
          version: "t",
          fetch: serve(board, state),
        });

      await run();
      const before = await storedRow(db, changedId);
      expect(before).toMatchObject({ closedAt: null });

      // The listing for the first posting changes; its detail fails this time.
      state.renamed = true;
      state.failing.add(changedId);
      state.detailCalls.length = 0;
      const failed = await run();
      expect(failed).toMatchObject({ listingComplete: true, detailsComplete: false, changed: 1 });
      const during = await storedRow(db, changedId);
      expect(during).toMatchObject({ closedAt: null, sourceHash: before!.sourceHash });

      // The next sync fetches it again, applies it and advances the stored hash.
      state.failing.clear();
      state.detailCalls.length = 0;
      const retried = await run();
      expect(retried).toMatchObject({ listingComplete: true, detailsComplete: true, changed: 1 });
      expect(state.detailCalls).toEqual([changedId]);
      const after = await storedRow(db, changedId);
      expect(after!.sourceHash).not.toBe(before!.sourceHash);
      expect(after).toMatchObject({ closedAt: null });
    });
  },
);

async function storedPostingIds(db: ReturnType<typeof testDb>): Promise<string[]> {
  const rows = await db.select({ postingId: schema.jobs.postingId }).from(schema.jobs);
  return rows.map((r) => r.postingId).sort();
}

async function storedRow(db: ReturnType<typeof testDb>, postingId: string) {
  const rows = await db
    .select({
      postingId: schema.jobs.postingId,
      sourceHash: schema.jobs.sourceHash,
      closedAt: schema.jobs.closedAt,
    })
    .from(schema.jobs);
  return rows.find((r) => r.postingId === postingId);
}
