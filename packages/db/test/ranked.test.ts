import { describe, expect, it } from "vitest";
import { countPostedSince, ftsScope, RANK_CANDIDATES, rankedJobs, schema } from "../src/index.ts";
import { testDb } from "../src/testing.ts";

const NOW = 2_000_000_000;
const DAY = 86_400;

type Db = ReturnType<typeof testDb>;

interface Seed {
  company?: string;
  title: string;
  location?: string;
  workMode?: "remote" | "onsite" | "hybrid" | null;
  sortAt?: number;
  closedAt?: number | null;
  dupOf?: number | null;
  sourceId?: string;
}

let counter = 0;

/** One visible job unless its fields say otherwise. Returns the row id. */
async function seed(db: Db, args: Seed): Promise<number> {
  counter += 1;
  const company = args.company ?? "Acme";
  const sourceId = args.sourceId ?? `greenhouse:${company.toLowerCase()}`;
  await db
    .insert(schema.sources)
    .values({
      id: sourceId,
      platform: "greenhouse",
      key: company.toLowerCase(),
      company,
      companySlug: company.toLowerCase(),
      params: {},
      lastListedAt: NOW,
    })
    .onConflictDoNothing();
  const [row] = await db
    .insert(schema.jobs)
    .values({
      sourceId,
      postingId: `p${counter}`,
      company,
      companySlug: company.toLowerCase(),
      title: args.title,
      excerpt: args.title,
      jdHash: `h${counter}`,
      jdBytes: 1,
      sourceHash: "s",
      facts: { platform: "greenhouse" },
      sortAt: args.sortAt ?? counter,
      firstSeenAt: 1,
      updatedAt: 1,
      locationText: args.location ?? "Remote, US",
      workMode: args.workMode === undefined ? "onsite" : args.workMode,
      closedAt: args.closedAt ?? null,
      dupOf: args.dupOf ?? null,
    })
    .returning({ id: schema.jobs.id });
  return row?.id ?? 0;
}

const titles = (rows: { title: string }[]) => rows.map((r) => r.title);
const ids = (rows: { id: number }[]) => rows.map((r) => r.id);
const page = { limit: 50, offset: 0 };

describe("ftsScope", () => {
  it("scopes each entry to its column, ANDs its words and ORs the entries", () => {
    expect(ftsScope("title", ["backend engineer", "platform"])).toBe(
      'title : (("backend" "engineer") OR "platform")',
    );
    expect(ftsScope("company", ["stripe"])).toBe('company : ("stripe")');
    expect(ftsScope("location_text", ["San Francisco", "Seattle"])).toBe(
      'location_text : (("san" "francisco") OR "seattle")',
    );
  });

  it("quotes every word, so no FTS operator or column name can come through", () => {
    const expression = ftsScope("title", ['engineer" OR company : *', 'NEAR(a b) ^ "x"']);
    expect(expression).toBe('title : (("engineer" "or" "company") OR ("near" "a" "b" "x"))');
  });

  it("is undefined when no entry has a word", () => {
    expect(ftsScope("title", [])).toBeUndefined();
    expect(ftsScope("title", ['"" ** ()', "--"])).toBeUndefined();
  });

  it("matches whole words only: no prefix, so 'eng' does not match 'Engineer'", async () => {
    const db = testDb();
    await seed(db, { title: "Engineer" });
    expect(await rankedJobs(db, { titles: ["eng"] }, page, NOW)).toEqual([]);
    expect(titles(await rankedJobs(db, { titles: ["engineer"] }, page, NOW))).toEqual(["Engineer"]);
  });
});

describe("rankedJobs", () => {
  it("ranks by relevance, not by newest: a tighter title match beats a newer, looser one", async () => {
    const db = testDb();
    const tight = await seed(db, { title: "Data Engineer", sortAt: 1 });
    const loose = await seed(db, {
      title: "Senior Staff Data Engineer Platform Infrastructure Team",
      sortAt: 9_999,
    });

    const rows = await rankedJobs(db, { titles: ["data engineer"] }, page, NOW);

    expect(ids(rows)).toEqual([tight, loose]);
  });

  it("ORs the title phrases and returns each job once", async () => {
    const db = testDb();
    await seed(db, { title: "Backend Engineer" });
    await seed(db, { title: "Platform Engineer" });
    await seed(db, { title: "Frontend Engineer" });

    const rows = await rankedJobs(
      db,
      { titles: ["backend engineer", "platform engineer", "backend engineer"] },
      page,
      NOW,
    );

    expect(titles(rows).sort()).toEqual(["Backend Engineer", "Platform Engineer"]);
  });

  it("is safe with hostile input and returns nothing for words that are not there", async () => {
    const db = testDb();
    await seed(db, { title: "Data Engineer" });
    expect(await rankedJobs(db, { titles: ['"" ** ()', "--"] }, page, NOW)).toEqual([]);
    expect(titles(await rankedJobs(db, { titles: ['data" OR title : *'] }, page, NOW))).toEqual([]);
  });

  it("never returns closed, duplicate or stale-source rows", async () => {
    const db = testDb();
    const keep = await seed(db, { title: "Data Engineer" });
    await seed(db, { title: "Data Engineer", closedAt: 5 });
    await seed(db, { title: "Data Engineer", company: "Dupe", dupOf: keep });
    await db.insert(schema.sources).values({
      id: "greenhouse:stale",
      platform: "greenhouse",
      key: "stale",
      company: "Stale",
      companySlug: "stale",
      params: {},
      lastListedAt: NOW - 30 * DAY,
    });
    await seed(db, { title: "Data Engineer", company: "Stale", sourceId: "greenhouse:stale" });

    expect(ids(await rankedJobs(db, { titles: ["data engineer"] }, page, NOW))).toEqual([keep]);
  });

  it("ANDs companies with the titles, scoped to the company column", async () => {
    const db = testDb();
    const stripe = await seed(db, { title: "Software Engineer", company: "Stripe" });
    await seed(db, { title: "Software Engineer", company: "Acme" });
    await seed(db, { title: "Account Executive", company: "Stripe" });

    const rows = await rankedJobs(
      db,
      { titles: ["software engineer"], companies: ["stripe"] },
      page,
      NOW,
    );

    expect(ids(rows)).toEqual([stripe]);
  });

  it("collapses one company and title across locations, showing the best one and the count", async () => {
    const db = testDb();
    const acmeIds = [
      await seed(db, { title: "Data Engineer", company: "Acme", location: "Seattle, WA" }),
      await seed(db, { title: "Data Engineer", company: "Acme", location: "Boston, MA" }),
      await seed(db, { title: "Data Engineer", company: "Acme", location: "Austin, TX" }),
    ];
    await seed(db, { title: "Data Engineer", company: "Other", location: "Seattle, WA" });

    const rows = await rankedJobs(db, { titles: ["data engineer"] }, page, NOW);

    expect(rows).toHaveLength(2);
    const acme = rows.find((r) => r.company === "Acme");
    expect(acme).toMatchObject({ locations: 3 });
    expect(acmeIds).toContain(acme?.id);
    expect(rows.find((r) => r.company === "Other")).toMatchObject({ locations: 1 });
  });

  it("ANDs the places with the titles, so local jobs are not crowded out", async () => {
    const db = testDb();
    const seattle = await seed(db, { title: "Data Engineer", location: "Seattle, WA" });
    await seed(db, { title: "Data Engineer", location: "Boston, MA", sortAt: 1e9 });

    const rows = await rankedJobs(
      db,
      { titles: ["data engineer"], locations: ["Seattle", "Redmond"] },
      page,
      NOW,
    );

    expect(ids(rows)).toEqual([seattle]);
  });

  it("ORs remote work with the places: a remote job anywhere, or a job in the place", async () => {
    const db = testDb();
    // Different companies: one company and title collapse into a single row.
    const seattle = await seed(db, {
      title: "Data Engineer",
      company: "A",
      location: "Seattle, WA",
      workMode: "onsite",
    });
    const remote = await seed(db, {
      title: "Data Engineer",
      company: "B",
      location: "Anywhere",
      workMode: "remote",
    });
    await seed(db, {
      title: "Data Engineer",
      company: "C",
      location: "Boston, MA",
      workMode: "onsite",
    });

    const rows = await rankedJobs(
      db,
      { titles: ["data engineer"], locations: ["Seattle"], remote: true },
      page,
      NOW,
    );
    expect(ids(rows).sort()).toEqual([seattle, remote].sort());
  });

  it("remote alone is a work-mode filter, and remote with no other place is not a text match", async () => {
    const db = testDb();
    const remote = await seed(db, {
      title: "Data Engineer",
      location: "Berlin",
      workMode: "remote",
    });
    await seed(db, { title: "Data Engineer", location: "Remote in name only", workMode: "onsite" });

    const rows = await rankedJobs(db, { titles: ["data engineer"], remote: true }, page, NOW);

    expect(ids(rows)).toEqual([remote]);
  });

  it("pages by offset in rank order, and never returns more than the candidates", async () => {
    const db = testDb();
    for (let i = 1; i <= 5; i++) await seed(db, { title: `Data Engineer ${i}`, company: `Co${i}` });

    const first = await rankedJobs(db, { titles: ["data engineer"] }, { limit: 2, offset: 0 }, NOW);
    const second = await rankedJobs(
      db,
      { titles: ["data engineer"] },
      { limit: 2, offset: 2 },
      NOW,
    );
    const all = await rankedJobs(db, { titles: ["data engineer"] }, { limit: 50, offset: 0 }, NOW);

    expect(ids([...first, ...second])).toEqual(ids(all).slice(0, 4));
    expect(all).toHaveLength(5);
  });

  it("reads at most RANK_CANDIDATES rows however many postings match", async () => {
    const db = testDb();
    const total = RANK_CANDIDATES + 100;
    const rows = Array.from({ length: total }, (_, i) => ({
      sourceId: "greenhouse:bulk",
      postingId: `b${i}`,
      company: `Co ${i}`,
      companySlug: `co-${i}`,
      title: "Data Engineer",
      excerpt: "x",
      jdHash: `bulk${i}`,
      jdBytes: 1,
      sourceHash: "s",
      facts: {},
      sortAt: i,
      firstSeenAt: 1,
      updatedAt: 1,
      locationText: "Remote",
      workMode: "onsite" as const,
    }));
    await db.insert(schema.sources).values({
      id: "greenhouse:bulk",
      platform: "greenhouse",
      key: "bulk",
      company: "Bulk",
      companySlug: "bulk",
      params: {},
      lastListedAt: NOW,
    });
    for (let i = 0; i < rows.length; i += 200) {
      await db.insert(schema.jobs).values(rows.slice(i, i + 200));
    }

    const got = await rankedJobs(db, { titles: ["data engineer"] }, { limit: 300, offset: 0 }, NOW);

    expect(got).toHaveLength(300);
    // Every candidate is newer than -1, so the count is exactly the candidate cap.
    expect(await countPostedSince(db, { titles: ["data engineer"] }, -1, 100000, NOW)).toBe(
      RANK_CANDIDATES,
    );
  });
});

describe("countPostedSince", () => {
  it("counts the best candidates posted after the time, up to the cap", async () => {
    const db = testDb();
    await seed(db, { title: "Data Engineer", company: "A", sortAt: 100 });
    await seed(db, { title: "Data Engineer", company: "B", sortAt: 300 });
    await seed(db, { title: "Data Engineer", company: "C", sortAt: 400 });

    expect(await countPostedSince(db, { titles: ["data engineer"] }, 200, 30, NOW)).toBe(2);
    expect(await countPostedSince(db, { titles: ["data engineer"] }, 200, 1, NOW)).toBe(1);
    expect(await countPostedSince(db, { titles: ["nothing"] }, 0, 30, NOW)).toBe(0);
  });

  it("counts a new role whose title ranks outside the best candidates", async () => {
    const db = testDb();
    // More old postings with short, high-ranking titles than the candidate window holds.
    await db.insert(schema.sources).values({
      id: "greenhouse:bulk",
      platform: "greenhouse",
      key: "bulk",
      company: "Bulk",
      companySlug: "bulk",
      params: {},
      lastListedAt: NOW,
    });
    const old = Array.from({ length: RANK_CANDIDATES }, (_, i) => ({
      sourceId: "greenhouse:bulk",
      postingId: `old${i}`,
      company: `Old ${i}`,
      companySlug: `old-${i}`,
      title: "Data Engineer",
      excerpt: "x",
      jdHash: `old${i}`,
      jdBytes: 1,
      sourceHash: "s",
      facts: {},
      sortAt: 1,
      firstSeenAt: 1,
      updatedAt: 1,
      locationText: "Remote",
      workMode: "onsite" as const,
    }));
    for (let i = 0; i < old.length; i += 200) {
      await db.insert(schema.jobs).values(old.slice(i, i + 200));
    }
    // Posted later, but with a long title: its bm25 rank is below all the old ones.
    const fresh = await seed(db, {
      title: "Senior Staff Data Engineer Platform Infrastructure Team",
      company: "Fresh",
      sortAt: 9_000,
    });

    const spec = { titles: ["data engineer"] };
    // Premise: the best-ranked list does not reach the new role within the candidate window.
    const ranked = await rankedJobs(db, spec, { limit: 300, offset: 0 }, NOW);
    expect(ids(ranked)).not.toContain(fresh);
    // The new-role count still finds it: it reads the newest candidates, not the best ones.
    expect(await countPostedSince(db, spec, 5_000, 30, NOW)).toBe(1);
  });
});
