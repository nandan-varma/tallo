import type { SearchSpec } from "@tallo/contracts";
import { schema } from "@tallo/db";
import { testDb } from "@tallo/db/testing";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { searchPage } from "../src/search.ts";

/**
 * The public ranking and paging output, byte for byte. The fixture is deterministic (a fixed linear congruential
 * generator, a fixed clock) and dense in the cases a rewrite can disturb: repeated titles (equal bm25 scores),
 * requisitions shared across locations, duplicate groups with open and closed siblings, closed rows, stale and
 * never-listed sources, and undated postings. The snapshot was written by the code before the query rewrite; any
 * change to ranking, grouping, sibling counts, paging or the cursor shows here as a diff.
 */

const NOW = 2_000_000_000;
const DAY = 86_400;

const SOURCES = [
  { id: "greenhouse:acme", company: "Acme", listedAt: NOW },
  { id: "greenhouse:beta", company: "Beta", listedAt: NOW - 3 * DAY },
  { id: "lever:gamma", company: "Gamma Labs", listedAt: NOW - 20 * DAY }, // stale-flag range, still shown
  { id: "greenhouse:delta", company: "Delta", listedAt: NOW - 40 * DAY }, // hidden: stopped listing
  { id: "greenhouse:never", company: "Never", listedAt: null }, // hidden: never listed
] as const;

const TITLES = [
  "Backend Engineer",
  "Senior Backend Engineer",
  "Data Engineer",
  "Data Scientist",
  "Platform Engineer",
  "Frontend Engineer",
  "Engineer",
  "Site Reliability Engineer",
];
const PLACES = [
  "Seattle, WA",
  "San Francisco, CA",
  "New York, NY",
  "Remote, US",
  "London, UK",
  "Austin, TX",
];

/**
 * A linear congruential generator: the same sequence on every run and machine. It samples the high bits: the low bits
 * of an LCG cycle with a short period, which would tie each draw to the one before it.
 */
function lcg(seed: number) {
  let state = seed >>> 0;
  return (n: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 2 ** 32) * n);
  };
}

async function fixture() {
  const db = testDb();
  for (const s of SOURCES) {
    await db.insert(schema.sources).values({
      id: s.id,
      platform: "greenhouse",
      key: s.id.split(":")[1] ?? "x",
      company: s.company,
      companySlug: s.company.toLowerCase().replaceAll(" ", "-"),
      params: {},
      lastListedAt: s.listedAt,
    });
  }
  const pick = lcg(20261121);
  const total = 260;
  const rows = Array.from({ length: total }, (_, i) => {
    const source = SOURCES[pick(SOURCES.length)] as (typeof SOURCES)[number];
    const title = TITLES[pick(TITLES.length)] as string;
    const place = PLACES[pick(PLACES.length)] as string;
    const reqPool = pick(4); // 0: no requisition; 1-3: a few shared requisitions across locations
    const companySlug = source.company.toLowerCase().replaceAll(" ", "-");
    // Company names repeat across sources, so a title repeats within one company (and one requisition).
    const company = pick(3) === 0 ? "Acme" : source.company;
    return {
      sourceId: source.id,
      postingId: `p${i}`,
      company,
      companySlug: company === "Acme" ? "acme" : companySlug,
      title,
      excerpt: `${title} at ${place}`,
      jdHash: `h${i}`,
      jdBytes: 1,
      sourceHash: "s",
      requisitionId: reqPool === 0 ? null : `R${pick(6)}`,
      locationText: place,
      city: place.split(",")[0] ?? null,
      countryCode: place.endsWith("UK") ? "GB" : "US",
      workMode: (pick(3) === 0 ? "remote" : pick(2) === 0 ? "onsite" : "hybrid") as
        | "remote"
        | "onsite"
        | "hybrid",
      postedAt: pick(4) === 0 ? null : NOW - pick(90) * DAY,
      facts: { compensation: pick(2) === 0 ? [{ min: 100000 + pick(9) * 1000 }] : [] },
      sortAt: NOW - pick(120) * DAY - (i % 7),
      firstSeenAt: 1,
      updatedAt: 1,
      // A closed row now and then; duplicates point at an earlier row of the same posting.
      closedAt: pick(9) === 0 ? NOW - pick(5) * DAY : null,
    };
  });
  for (let i = 0; i < rows.length; i += 50) {
    await db.insert(schema.jobs).values(rows.slice(i, i + 50));
  }
  // Duplicate groups: a fifth of the rows become siblings of a lower id (open or closed siblings alike).
  const ids = (
    await db.select({ id: schema.jobs.id }).from(schema.jobs).orderBy(schema.jobs.id)
  ).map((r) => r.id);
  for (let i = 5; i < ids.length; i += 5) {
    const canonical = ids[(i * 7) % (i - 1)] as number;
    await db
      .update(schema.jobs)
      .set({ dupOf: canonical })
      .where(eq(schema.jobs.id, ids[i] as number));
  }
  return db;
}

/** Every page of a spec, walked by offset the way a client walks `next`. */
async function walk(db: Awaited<ReturnType<typeof fixture>>, spec: SearchSpec, limit: number) {
  const pages = [];
  let offset = 0;
  for (let guard = 0; guard < 40; guard++) {
    const page = await searchPage(db, { ...spec, offset, limit }, NOW);
    pages.push({
      offset,
      hits: page.hits,
      count: page.count,
      nextOffset: page.nextOffset,
      hasMore: page.hasMore,
      capped: page.capped,
      expanded: page.expanded,
    });
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  return pages;
}

const SPECS: SearchSpec[] = [
  { queries: ["backend engineer"] },
  { queries: ["data engineer", "data scientist"] },
  { queries: ["engineer"] },
  { queries: ["engineer"], sort: "recent" },
  { queries: ["engineer"], sort: "posted" },
  { queries: ["engineer"], sort: "added" },
  { queries: ["platform engineer"], companies: ["acme"] },
  { queries: ["engineer"], locations: ["seattle", "san francisco"] },
  { queries: ["engineer"], locations: ["remote"] },
  { queries: ["engineer", "reliability"], locations: ["new york"], sort: "recent" },
  { queries: ["frontend"], companies: ["gamma"] },
];

describe("public ranking and paging output (golden)", () => {
  it("matches the recorded output for every spec, page size and walk", async () => {
    const db = await fixture();
    const out: Record<string, unknown> = {};
    for (const [i, spec] of SPECS.entries()) {
      for (const limit of [3, 25]) {
        out[`spec${i}.limit${limit}`] = await walk(db, spec, limit);
      }
    }
    await expect(JSON.stringify(out, null, 1)).toMatchFileSnapshot("./golden/ranking.json");
  });
});
