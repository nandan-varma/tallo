import { gzip, sha256 } from "@tallo/catalog";
import { jdKey, memoryBlobs, schema } from "@tallo/db";
import { testDb } from "@tallo/db/testing";

export const SOURCE = "greenhouse:acme";
export const now = () => Math.floor(Date.now() / 1000);

export type Db = ReturnType<typeof testDb>;
export type Blobs = ReturnType<typeof memoryBlobs>;

/** One job row, visible by default; `closed` and `dupOf` turn it into a row the site hides. */
export async function seed(
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
    countryCode?: string | null;
    workMode?: "remote" | "onsite";
    sortAt?: number;
    postedAt?: number | null;
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
      postedAt: args.postedAt ?? null,
      firstSeenAt: 1,
      updatedAt: 1,
      locationText: args.location ?? "Remote, US",
      countryCode: args.countryCode ?? null,
      workMode: args.workMode ?? "remote",
      closedAt: args.closed ? 2 : null,
      dupOf: args.dupOf ?? null,
    })
    .returning({ id: schema.jobs.id });
  return row?.id ?? 0;
}

export function setup() {
  const db = testDb();
  const blobs = memoryBlobs();
  return { db, blobs };
}
