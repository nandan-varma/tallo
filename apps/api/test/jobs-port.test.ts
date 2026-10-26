import { gzip, sha256 } from "@tallo/catalog";
import { jdKey, memoryBlobs, schema } from "@tallo/db";
import { testDb } from "@tallo/db/testing";
import { describe, expect, it } from "vitest";
import { jobsPort, searchPage } from "../src/jobs-port.ts";

const SOURCE = "greenhouse:acme";
const now = () => Math.floor(Date.now() / 1000);

type Db = ReturnType<typeof testDb>;
type Blobs = ReturnType<typeof memoryBlobs>;

/** One job row, visible by default; flags turn it into a row the site hides. */
async function seed(
  db: Db,
  blobs: Blobs,
  args: {
    postingId: string;
    title: string;
    description?: string;
    closed?: boolean;
    hidden?: boolean;
    dupOf?: number;
    pay?: [number, number];
    location?: string;
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
  const [row] = await db
    .insert(schema.jobs)
    .values({
      sourceId: SOURCE,
      postingId: args.postingId,
      company: "Acme",
      companySlug: "acme",
      title: args.title,
      classifierVersion: 1,
      excerpt: text.slice(0, 80),
      jdHash,
      jdBytes: text.length,
      sourceHash: "b".repeat(64),
      facts: { platform: "greenhouse" },
      sortAt: 1000 + Number(args.postingId),
      firstSeenAt: 1,
      updatedAt: 1,
      locationText: args.location ?? "Remote, US",
      workMode: "remote",
      salaryMinAnnual: args.pay?.[0] ?? null,
      salaryMaxAnnual: args.pay?.[1] ?? null,
      salaryCurrency: args.pay ? "USD" : null,
      closedAt: args.closed ? 2 : null,
      hidden: args.hidden ? 1 : 0,
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

describe("jobsPort.search", () => {
  it("matches every term of a phrase, so a title phrase stays narrow", async () => {
    const { db, blobs, port } = setup();
    await seed(db, blobs, { postingId: "1", title: "Backend Engineer" });
    await seed(db, blobs, { postingId: "2", title: "Frontend Engineer" });

    const hits = await port.search(["backend engineer"], 40);

    expect(hits.map((h) => h.title)).toEqual(["Backend Engineer"]);
  });

  it("returns compact hits with unknowns as null and pay as text", async () => {
    const { db, blobs, port } = setup();
    await seed(db, blobs, { postingId: "1", title: "Platform Engineer", pay: [150000, 180000] });
    await seed(db, blobs, { postingId: "2", title: "Platform Engineer II" });

    const hits = await port.search(["platform engineer"], 40);

    const paid = hits.find((h) => h.title === "Platform Engineer");
    const unpaid = hits.find((h) => h.title === "Platform Engineer II");
    expect(paid).toMatchObject({
      company: "Acme",
      workMode: "remote",
      pay: "USD 150000-180000 per year",
    });
    expect(unpaid?.pay).toBeNull();
    expect(unpaid?.department).toBeNull();
  });

  it("merges phrases round-robin, once per job, and stops at the limit", async () => {
    const { db, blobs, port } = setup();
    for (let i = 1; i <= 5; i++)
      await seed(db, blobs, { postingId: `${i}`, title: `Backend Engineer ${i}` });
    for (let i = 6; i <= 10; i++)
      await seed(db, blobs, { postingId: `${i}`, title: `Platform Engineer ${i}` });

    const hits = await port.search(
      ["backend engineer", "platform engineer", "backend engineer"],
      4,
    );

    expect(hits).toHaveLength(4);
    expect(new Set(hits.map((h) => h.id)).size).toBe(4);
    // Both phrases are represented even though the first alone could fill the limit.
    expect(hits.some((h) => h.title.startsWith("Backend"))).toBe(true);
    expect(hits.some((h) => h.title.startsWith("Platform"))).toBe(true);
  });

  it("never returns closed, hidden or duplicate rows", async () => {
    const { db, blobs, port } = setup();
    const keep = await seed(db, blobs, { postingId: "1", title: "Data Engineer" });
    await seed(db, blobs, { postingId: "2", title: "Data Engineer", closed: true });
    await seed(db, blobs, { postingId: "3", title: "Data Engineer", hidden: true });
    await seed(db, blobs, { postingId: "4", title: "Data Engineer", dupOf: keep });

    const hits = await port.search(["data engineer"], 40);

    expect(hits.map((h) => h.id)).toEqual([String(keep)]);
  });

  it("skips phrases with no searchable word", async () => {
    const { db, blobs, port } = setup();
    await seed(db, blobs, { postingId: "1", title: "Data Engineer" });
    expect(await port.search(['"" ** ()', "data engineer"], 40)).toHaveLength(1);
    expect(await port.search(["--"], 40)).toEqual([]);
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
    const hidden = await seed(db, blobs, { postingId: "2", title: "B", hidden: true });
    const dup = await seed(db, blobs, { postingId: "3", title: "C", dupOf: closed });

    for (const id of [closed, hidden, dup, 9999]) expect(await port.read(String(id))).toBeNull();
    for (const id of ["abc", "-1", "1.5", ""]) expect(await port.read(id)).toBeNull();
  });
});

describe("jobsPort.search with locations", () => {
  async function places() {
    const { db, blobs, port } = setup();
    await seed(db, blobs, {
      postingId: "1",
      title: "Data Engineer",
      location: "Seattle, WA, United States",
    });
    await seed(db, blobs, {
      postingId: "2",
      title: "Data Engineer",
      location: "Washington, DC, United States",
    });
    await seed(db, blobs, {
      postingId: "3",
      title: "Data Engineer",
      location: "Boston, MA, United States",
    });
    await seed(db, blobs, { postingId: "4", title: "Data Engineer", location: "Redmond, WA" });
    return { db, port };
  }
  const cities = (hits: { location: string | null }[]) => hits.map((h) => h.location).sort();

  it("requires the place, so local jobs are not crowded out by newer ones elsewhere", async () => {
    const { port } = await places();
    const hits = await port.search(["data engineer"], 40, {
      locations: ["Seattle", "Redmond", "WA"],
    });
    expect(cities(hits)).toEqual(["Redmond, WA", "Seattle, WA, United States"]);
  });

  it("keeps Washington state apart from Washington, DC by the words the caller gives", async () => {
    const { port } = await places();
    const state = await port.search(["data engineer"], 40, { locations: ["WA"] });
    expect(cities(state)).toEqual(["Redmond, WA", "Seattle, WA, United States"]);
    const capital = await port.search(["data engineer"], 40, { locations: ["Washington", "DC"] });
    expect(cities(capital)).toEqual(["Washington, DC, United States"]);
  });

  it("an entry needs all of its words; entries are alternatives", async () => {
    const { port } = await places();
    expect(await port.search(["data engineer"], 40, { locations: ["Seattle Boston"] })).toEqual([]);
    expect(
      cities(await port.search(["data engineer"], 40, { locations: ["Boston", "Seattle"] })),
    ).toEqual(["Boston, MA, United States", "Seattle, WA, United States"]);
  });

  it("is safe against search syntax: only its words count, and a place with no words is ignored", async () => {
    const { port } = await places();
    // The words "or" and "near" are searched like any other, so nothing matches, and nothing throws.
    expect(await port.search(["data engineer"], 40, { locations: ['" OR *', "NEAR("] })).toEqual(
      [],
    );
    expect(await port.search(["data engineer"], 40, { locations: ["--"] })).toHaveLength(4);
    expect(await port.search(["data engineer"], 40, { locations: [] })).toHaveLength(4);
  });
});

describe("jobsPort.lookup", () => {
  it("returns only jobs the site shows, once each, and ignores bad ids", async () => {
    const { db, blobs, port } = setup();
    const open = await seed(db, blobs, { postingId: "1", title: "Data Engineer" });
    const closed = await seed(db, blobs, { postingId: "2", title: "Data Engineer", closed: true });
    const hidden = await seed(db, blobs, { postingId: "3", title: "Data Engineer", hidden: true });

    const hits = await port.lookup([
      String(open),
      String(open),
      String(closed),
      String(hidden),
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

  it("pages newest first with a cursor, and ends with none", async () => {
    const db = await catalog();
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 5; guard++) {
      const page = await searchPage(db, { queries: ["data engineer"], cursor, limit: 2 });
      sizes.push(page.hits.length);
      seen.push(...page.hits.map((h) => h.title));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(sizes).toEqual([2, 2, 1]);
    expect(seen).toEqual([
      "Data Engineer 5",
      "Data Engineer 4",
      "Data Engineer 3",
      "Data Engineer 2",
      "Data Engineer 1",
    ]);
  });

  it("covers every phrase (OR), requires the places (AND), and never lists closed jobs", async () => {
    const db = await catalog();
    const both = await searchPage(db, {
      queries: ["data engineer", "platform engineer"],
      limit: 30,
    });
    expect(both.hits).toHaveLength(6);
    const seattle = await searchPage(db, {
      queries: ["data engineer", "platform engineer"],
      locations: ["Seattle"],
      limit: 30,
    });
    expect(seattle.hits.map((h) => h.title).sort()).toEqual([
      "Data Engineer 1",
      "Data Engineer 3",
      "Data Engineer 5",
      "Platform Engineer",
    ]);
  });

  it("answers an empty page for phrases with no searchable word", async () => {
    const db = await catalog();
    expect(await searchPage(db, { queries: ['"" **'], limit: 10 })).toEqual({
      hits: [],
      nextCursor: null,
    });
  });
});
