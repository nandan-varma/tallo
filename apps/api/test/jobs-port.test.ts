import { gzip, sha256 } from "@tallo/catalog";
import { jdKey, memoryBlobs, schema } from "@tallo/db";
import { testDb } from "@tallo/db/testing";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { jobsPort } from "../src/jobs-port.ts";

const SOURCE = "greenhouse:acme";
const now = () => Math.floor(Date.now() / 1000);

/** Visible, open, canonical job rows by default; flags turn one into an invisible row. */
async function seed(
  db: ReturnType<typeof testDb>,
  blobs: ReturnType<typeof memoryBlobs>,
  args: {
    postingId: string;
    title: string;
    description?: string;
    closed?: boolean;
    hidden?: boolean;
    dupOf?: number;
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
      facts: {},
      sortAt: 1000 + Number(args.postingId),
      firstSeenAt: 1,
      updatedAt: 1,
      locationText: "Remote, US",
      closedAt: args.closed ? 2 : null,
      hidden: args.hidden ? 1 : 0,
      dupOf: args.dupOf ?? null,
    })
    .returning({ id: schema.jobs.id });
  return row?.id ?? 0;
}

/**
 * 100k synthetic open jobs, built in SQL (one recursive insert, FTS triggers included). About 82%
 * have "engineer" in the title, so a single common word matches most of the table. 1% are
 * "Backend Engineer" and 1% "Platform Engineer".
 */
async function seedCatalog(db: ReturnType<typeof testDb>, rows: number) {
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
  await db.run(
    sql.raw(`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows})
    INSERT INTO jobs (source_id, posting_id, company, company_slug, title, classifier_version, excerpt,
      jd_hash, jd_bytes, source_hash, facts, sort_at, first_seen_at, updated_at, location_text, hidden)
    SELECT '${SOURCE}', 'p' || i, 'Acme', 'acme',
      CASE WHEN i % 100 = 0 THEN 'Backend Engineer ' || i
           WHEN i % 100 = 1 THEN 'Platform Engineer ' || i
           WHEN i % 10 < 8 THEN 'Software Engineer ' || i
           ELSE 'Data Analyst ' || i END,
      1, 'x', 'h', 1, 'h', '{}', i, i, i, 'Remote, US', 0
    FROM n
  `),
  );
}

async function countMatches(db: ReturnType<typeof testDb>, match: string): Promise<number> {
  const rows = (await db.all(
    sql`SELECT count(*) FROM jobs_fts WHERE jobs_fts MATCH ${match}`,
  )) as unknown as unknown[];
  const first = rows[0];
  return Number(Array.isArray(first) ? first[0] : Object.values(first ?? {})[0]);
}

describe("jobsPort.recall", () => {
  it("makes one bounded read per variant (at most 12), with no cursor paging", async () => {
    const db = testDb();
    const blobs = memoryBlobs();
    await seed(db, blobs, { postingId: "1", title: "Backend Engineer" });
    const select = vi.spyOn(db, "select");
    const variants = Array.from({ length: 15 }, () => "backend engineer");

    const port = jobsPort(db, blobs);
    const pool = await port.recall(variants, 300);

    // 15 variants in, 12 read: one select per variant, never a second page.
    expect(select).toHaveBeenCalledTimes(12);
    expect(pool.map((c) => c.title)).toEqual(["Backend Engineer"]);
  });

  it("returns at most 100 rows per variant, even for one common word", async () => {
    const db = testDb();
    const blobs = memoryBlobs();
    await seedCatalog(db, 100_000);
    const select = vi.spyOn(db, "select");

    const pool = await jobsPort(db, blobs).recall(["engineer"], 300);

    expect(select).toHaveBeenCalledTimes(1);
    expect(pool.length).toBe(100);
  });

  it("is selective: a title phrase matches far fewer rows than a common word", async () => {
    const db = testDb();
    const blobs = memoryBlobs();
    await seedCatalog(db, 100_000);

    // The rows a recall variant sorts are its FTS matches. Exact terms with AND keep them narrow.
    const common = await countMatches(db, '"engineer"');
    const title = await countMatches(db, '"backend" "engineer"');
    expect(common).toBeGreaterThan(70_000);
    expect(title).toBe(1_000);
    expect(title * 50).toBeLessThan(common);

    // The port reads one page of the title matches: the first 100 by sortAt, all of them titles.
    const pool = await jobsPort(db, blobs).recall(["backend engineer"], 300);
    expect(title).toBeGreaterThan(100);
    expect(pool.length).toBe(100);
    expect(pool.every((c) => c.title.startsWith("Backend Engineer"))).toBe(true);
  });

  it("never returns a duplicate (dup_of set), closed or hidden row", async () => {
    const db = testDb();
    const blobs = memoryBlobs();
    const canonical = await seed(db, blobs, { postingId: "1", title: "Backend Engineer" });
    const dup = await seed(db, blobs, {
      postingId: "2",
      title: "Backend Engineer",
      dupOf: canonical,
    });
    const closed = await seed(db, blobs, {
      postingId: "3",
      title: "Backend Engineer",
      closed: true,
    });
    const hidden = await seed(db, blobs, {
      postingId: "4",
      title: "Backend Engineer",
      hidden: true,
    });

    const port = jobsPort(db, blobs);
    const pool = await port.recall(["backend engineer"], 300);
    expect(pool.map((c) => c.id)).toEqual([String(canonical)]);
    expect(pool.map((c) => c.id)).not.toContain(String(dup));

    // Facts and descriptions use the same predicate: ids that are not visible return nothing.
    for (const id of [dup, closed, hidden]) {
      expect((await port.facts([String(id)])).size).toBe(0);
      expect(await port.description(String(id))).toBeNull();
    }
    expect(await port.description(String(canonical))).toBe("Backend Engineer description");
    expect((await port.facts([String(canonical)])).has(String(canonical))).toBe(true);
  });

  it("matches whole terms only: every term must match, and no term is a prefix", async () => {
    const db = testDb();
    const blobs = memoryBlobs();
    await seed(db, blobs, { postingId: "1", title: "Backend Engineer" });
    await seed(db, blobs, { postingId: "2", title: "Backend Manager" });
    await seed(db, blobs, { postingId: "3", title: "Backendish Engineering Lead" });
    const port = jobsPort(db, blobs);

    // Every term is required (AND), not any of them.
    const both = await port.recall(["backend engineer"], 300);
    expect(both.map((c) => c.title)).toEqual(["Backend Engineer"]);
    // A term is a whole token, not a prefix: "back" must not reach "Backend" (ftsQuery would add `*`).
    expect(await port.recall(["back"], 300)).toEqual([]);
  });

  it("treats FTS operator text in a variant as plain words (no syntax injection)", async () => {
    const db = testDb();
    const blobs = memoryBlobs();
    await seed(db, blobs, { postingId: "1", title: "Backend Engineer" });

    const pool = await jobsPort(db, blobs).recall(
      ['backend" OR title:"x', "NEAR(backend engineer)", "*", '"', "backend engineer*"],
      300,
    );
    expect(pool.map((c) => c.title)).toEqual(["Backend Engineer"]);
  });
});
