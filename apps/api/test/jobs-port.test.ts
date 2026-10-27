import { gzip, sha256 } from "@tallo/catalog";
import { jdKey, memoryBlobs, schema } from "@tallo/db";
import { testDb } from "@tallo/db/testing";
import { describe, expect, it } from "vitest";
import { jobsPort, newCountSince, searchPage } from "../src/jobs-port.ts";

const SOURCE = "greenhouse:acme";
const now = () => Math.floor(Date.now() / 1000);

type Db = ReturnType<typeof testDb>;
type Blobs = ReturnType<typeof memoryBlobs>;

/** One job row, visible by default; `closed` and `dupOf` turn it into a row the site hides. */
async function seed(
  db: Db,
  blobs: Blobs,
  args: {
    postingId: string;
    title: string;
    company?: string;
    description?: string;
    closed?: boolean;
    dupOf?: number;
    pay?: [number, number];
    location?: string;
    workMode?: "remote" | "onsite";
    sortAt?: number;
  },
): Promise<number> {
  const text = args.description ?? `${args.title} description`;
  const jdHash = await sha256(text);
  await blobs.put(jdKey(jdHash), await gzip(new TextEncoder().encode(text)));
  await db
    .insert(schema.sources)
    .values({
      id: SOURCE,
      platform: "greenhouse",
      key: "acme",
      company: "Acme",
      companySlug: "acme",
      params: {},
      lastListedAt: now(),
    })
    .onConflictDoNothing();
  const company = args.company ?? "Acme";
  const [row] = await db
    .insert(schema.jobs)
    .values({
      sourceId: SOURCE,
      postingId: args.postingId,
      company,
      companySlug: company.toLowerCase().replace(/\s+/g, "-"),
      title: args.title,
      excerpt: text.slice(0, 80),
      jdHash,
      jdBytes: text.length,
      sourceHash: "b".repeat(64),
      facts: args.pay
        ? {
            platform: "greenhouse",
            compensation: [
              {
                min: args.pay[0],
                max: args.pay[1],
                currency: "USD",
                interval: "year",
                component: "base",
              },
            ],
          }
        : { platform: "greenhouse" },
      sortAt: args.sortAt ?? 1000 + Number(args.postingId),
      firstSeenAt: 1,
      updatedAt: 1,
      locationText: args.location ?? "Remote, US",
      workMode: args.workMode ?? "remote",
      closedAt: args.closed ? 2 : null,
      dupOf: args.dupOf ?? null,
    })
    .returning({ id: schema.jobs.id });
  return row?.id ?? 0;
}

function setup() {
  const db = testDb();
  const blobs = memoryBlobs();
  return { db, blobs, port: jobsPort(db, blobs) };
}

const titles = (hits: { title: string }[]) => hits.map((h) => h.title);

describe("jobsPort.search", () => {
  it("matches every word of a title phrase, so a phrase stays narrow", async () => {
    const { db, blobs, port } = setup();
    await seed(db, blobs, { postingId: "1", title: "Backend Engineer" });
    await seed(db, blobs, { postingId: "2", title: "Frontend Engineer" });

    const hits = await port.search({ queries: ["backend engineer"] }, 40);

    expect(titles(hits)).toEqual(["Backend Engineer"]);
  });

  it("returns compact hits with unknowns as null and the stated pay line as text", async () => {
    const { db, blobs, port } = setup();
    await seed(db, blobs, { postingId: "1", title: "Platform Engineer", pay: [150000, 180000] });
    await seed(db, blobs, { postingId: "2", title: "Platform Engineer II" });

    const hits = await port.search({ queries: ["platform engineer"] }, 40);

    const paid = hits.find((h) => h.title === "Platform Engineer");
    const unpaid = hits.find((h) => h.title === "Platform Engineer II");
    expect(paid).toMatchObject({
      company: "Acme",
      workMode: "remote",
      pay: "USD 150000-180000 per year",
      locations: 1,
    });
    expect((await port.lookup([String(paid?.id)]))[0]?.pay).toBe("USD 150000-180000 per year");
    expect(unpaid?.pay).toBeNull();
    expect(unpaid?.department).toBeNull();
  });

  it("ranks one OR across the phrases, each job once, and stops at the limit", async () => {
    const { db, blobs, port } = setup();
    for (let i = 1; i <= 5; i++)
      await seed(db, blobs, {
        postingId: `${i}`,
        title: `Backend Engineer ${i}`,
        company: `B${i}`,
      });
    for (let i = 6; i <= 10; i++)
      await seed(db, blobs, {
        postingId: `${i}`,
        title: `Platform Engineer ${i}`,
        company: `P${i}`,
      });

    const hits = await port.search(
      { queries: ["backend engineer", "platform engineer", "backend engineer"] },
      4,
    );

    expect(hits).toHaveLength(4);
    expect(new Set(hits.map((h) => h.id)).size).toBe(4);
  });

  it("collapses one company and title across locations into one hit with the count", async () => {
    const { db, blobs, port } = setup();
    await seed(db, blobs, { postingId: "1", title: "Data Engineer", location: "Seattle, WA" });
    await seed(db, blobs, { postingId: "2", title: "Data Engineer", location: "Boston, MA" });
    await seed(db, blobs, { postingId: "3", title: "Data Engineer", location: "Austin, TX" });
    await seed(db, blobs, { postingId: "4", title: "Data Engineer", company: "Other" });

    const hits = await port.search({ queries: ["data engineer"] }, 40);

    expect(hits).toHaveLength(2);
    expect(hits.find((h) => h.company === "Acme")).toMatchObject({ locations: 3 });
    expect(hits.find((h) => h.company === "Other")).toMatchObject({ locations: 1 });
  });

  it("never returns closed or duplicate rows", async () => {
    const { db, blobs, port } = setup();
    const keep = await seed(db, blobs, { postingId: "1", title: "Data Engineer" });
    await seed(db, blobs, { postingId: "2", title: "Data Engineer", closed: true, company: "C" });
    await seed(db, blobs, { postingId: "4", title: "Data Engineer", dupOf: keep, company: "D" });

    const hits = await port.search({ queries: ["data engineer"] }, 40);

    expect(hits.map((h) => h.id)).toEqual([String(keep)]);
  });

  it("skips phrases with no searchable word", async () => {
    const { db, blobs, port } = setup();
    await seed(db, blobs, { postingId: "1", title: "Data Engineer" });
    expect(await port.search({ queries: ['"" ** ()', "data engineer"] }, 40)).toHaveLength(1);
    expect(await port.search({ queries: ["--"] }, 40)).toEqual([]);
  });
});

describe("jobsPort.read", () => {
  it("returns the full description, never truncated, with the apply link and facts", async () => {
    const { db, blobs, port } = setup();
    const description = `${"Intro paragraph. ".repeat(3_000)}\nPay: $200,000.\nMinimum 6 years of Go.`;
    const id = await seed(db, blobs, { postingId: "1", title: "Staff Engineer", description });

    const job = await port.read(String(id));

    expect(job?.description).toBe(description);
    expect(job?.description?.length).toBeGreaterThan(50_000);
    expect(job?.facts).toEqual({ platform: "greenhouse" });
    expect(job?.title).toBe("Staff Engineer");
  });

  it("refuses ids the site hides, and ids that are not ids", async () => {
    const { db, blobs, port } = setup();
    const closed = await seed(db, blobs, { postingId: "1", title: "A", closed: true });
    const dup = await seed(db, blobs, { postingId: "3", title: "C", dupOf: closed });

    for (const id of [closed, dup, 9999]) expect(await port.read(String(id))).toBeNull();
    for (const id of ["abc", "-1", "1.5", ""]) expect(await port.read(id)).toBeNull();
  });
});

describe("jobsPort.search with places", () => {
  /** Four data engineer postings in four places, each at its own company so they do not collapse. */
  async function places() {
    const { db, blobs, port } = setup();
    const at = (postingId: string, location: string, workMode: "remote" | "onsite" = "onsite") =>
      seed(db, blobs, {
        postingId,
        title: "Data Engineer",
        company: `Co ${postingId}`,
        location,
        workMode,
      });
    await at("1", "Seattle, WA, United States");
    await at("2", "Washington, DC, United States");
    await at("3", "Boston, MA, United States");
    await at("4", "Redmond, WA");
    await at("5", "Anywhere", "remote");
    return { db, port };
  }
  const cities = (hits: { location: string | null }[]) => hits.map((h) => h.location).sort();

  it("requires the place, so local jobs are not crowded out by newer ones elsewhere", async () => {
    const { port } = await places();
    const hits = await port.search(
      { queries: ["data engineer"], locations: ["Seattle", "Redmond"] },
      40,
    );
    expect(cities(hits)).toEqual(["Redmond, WA", "Seattle, WA, United States"]);
  });

  it("expands a state word to the state, and keeps Washington, DC for DC words", async () => {
    const { port } = await places();
    const state = await port.search({ queries: ["data engineer"], locations: ["Washington"] }, 40);
    expect(cities(state)).toEqual(["Redmond, WA", "Seattle, WA, United States"]);
    const capital = await port.search(
      { queries: ["data engineer"], locations: ["Washington DC"] },
      40,
    );
    expect(cities(capital)).toEqual(["Washington, DC, United States"]);
  });

  it("treats each place as alternatives, and passes unknown words through as their own text", async () => {
    const { port } = await places();
    expect(
      await port.search({ queries: ["data engineer"], locations: ["Seattle Boston"] }, 40),
    ).toEqual([]);
    expect(
      cities(
        await port.search({ queries: ["data engineer"], locations: ["Boston", "Redmond"] }, 40),
      ),
    ).toEqual(["Boston, MA, United States", "Redmond, WA"]);
  });

  it("is safe against search syntax: only its words count, and a place with no words is ignored", async () => {
    const { port } = await places();
    expect(
      await port.search({ queries: ["data engineer"], locations: ['" OR *', "NEAR("] }, 40),
    ).toEqual([]);
    expect(await port.search({ queries: ["data engineer"], locations: ["--"] }, 40)).toHaveLength(
      5,
    );
    expect(await port.search({ queries: ["data engineer"], locations: [] }, 40)).toHaveLength(5);
  });

  it("ORs remote work with the named places, and remote alone is the remote postings", async () => {
    const { port } = await places();
    const both = await port.search(
      { queries: ["data engineer"], locations: ["Seattle", "remote"] },
      40,
    );
    expect(cities(both)).toEqual(["Anywhere", "Redmond, WA", "Seattle, WA, United States"]);
    const remoteOnly = await port.search({ queries: ["data engineer"], locations: ["remote"] }, 40);
    expect(cities(remoteOnly)).toEqual(["Anywhere"]);
  });
});

describe("jobsPort.lookup", () => {
  it("returns only jobs the site shows, once each, and ignores bad ids", async () => {
    const { db, blobs, port } = setup();
    const open = await seed(db, blobs, { postingId: "1", title: "Data Engineer" });
    const closed = await seed(db, blobs, { postingId: "2", title: "Data Engineer", closed: true });

    const hits = await port.lookup([
      String(open),
      String(open),
      String(closed),
      "9999",
      "abc",
      "-4",
    ]);

    expect(hits.map((h) => h.id)).toEqual([String(open)]);
    expect(await port.lookup([])).toEqual([]);
  });
});

describe("searchPage", () => {
  async function catalog() {
    const { db, blobs } = setup();
    for (let i = 1; i <= 5; i++) {
      await seed(db, blobs, {
        postingId: `${i}`,
        title: `Data Engineer ${i}`,
        location: i % 2 ? "Seattle, WA" : "Boston, MA",
      });
    }
    await seed(db, blobs, { postingId: "6", title: "Platform Engineer", location: "Seattle, WA" });
    await seed(db, blobs, {
      postingId: "7",
      title: "Data Engineer 7",
      location: "Seattle, WA",
      closed: true,
    });
    return db;
  }

  it("pages by offset until the last page, which has no next offset", async () => {
    const db = await catalog();
    const sizes: number[] = [];
    const seen: string[] = [];
    let offset = 0;
    for (let guard = 0; guard < 5; guard++) {
      const page = await searchPage(db, { queries: ["data engineer"], offset, limit: 2 });
      sizes.push(page.hits.length);
      seen.push(...titles(page.hits));
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    expect(sizes).toEqual([2, 2, 1]);
    expect(seen.sort()).toEqual([
      "Data Engineer 1",
      "Data Engineer 2",
      "Data Engineer 3",
      "Data Engineer 4",
      "Data Engineer 5",
    ]);
  });

  it("covers every phrase (OR), requires the places (AND), and never lists closed jobs", async () => {
    const db = await catalog();
    const both = await searchPage(db, {
      queries: ["data engineer", "platform engineer"],
      offset: 0,
      limit: 30,
    });
    expect(both.hits).toHaveLength(6);
    const seattle = await searchPage(db, {
      queries: ["data engineer", "platform engineer"],
      locations: ["Seattle"],
      offset: 0,
      limit: 30,
    });
    expect(titles(seattle.hits).sort()).toEqual([
      "Data Engineer 1",
      "Data Engineer 3",
      "Data Engineer 5",
      "Platform Engineer",
    ]);
  });

  it("answers an empty page for phrases with no searchable word", async () => {
    const db = await catalog();
    expect(await searchPage(db, { queries: ['"" **'], offset: 0, limit: 10 })).toEqual({
      hits: [],
      nextOffset: null,
    });
  });

  it("stops at SEARCH_RESULT_CAP in total, with no next offset past it", async () => {
    const { db, blobs } = setup();
    for (let i = 1; i <= 310; i++) {
      await seed(db, blobs, { postingId: `${i}`, title: `Data Engineer ${i}`, company: `Co ${i}` });
    }
    const first = await searchPage(db, { queries: ["data engineer"], offset: 0, limit: 30 });
    expect(first.hits).toHaveLength(30);
    expect(first.nextOffset).toBe(30);

    const last = await searchPage(db, { queries: ["data engineer"], offset: 290, limit: 30 });
    expect(last.hits).toHaveLength(10);
    expect(last.nextOffset).toBeNull();
  });

  it("returns the hits with their location count and the same ranking as the port", async () => {
    const { db, blobs } = setup();
    await seed(db, blobs, { postingId: "1", title: "Data Engineer", location: "Seattle, WA" });
    await seed(db, blobs, { postingId: "2", title: "Data Engineer", location: "Boston, MA" });
    const page = await searchPage(db, { queries: ["data engineer"], offset: 0, limit: 20 });
    expect(page.hits).toEqual([expect.objectContaining({ title: "Data Engineer", locations: 2 })]);
  });
});

describe("newCountSince", () => {
  it("counts the best matches posted after the time, up to the cap", async () => {
    const { db, blobs } = setup();
    await seed(db, blobs, { postingId: "1", title: "Data Engineer", company: "A", sortAt: 100 });
    await seed(db, blobs, { postingId: "2", title: "Data Engineer", company: "B", sortAt: 300 });
    await seed(db, blobs, { postingId: "3", title: "Data Engineer", company: "C", sortAt: 400 });
    const spec = { queries: ["data engineer"] };

    expect(await newCountSince(db, spec, 200, 30)).toBe(2);
    expect(await newCountSince(db, spec, 200, 1)).toBe(1);
    expect(await newCountSince(db, { queries: ["nothing here"] }, 0, 30)).toBe(0);
  });
});
