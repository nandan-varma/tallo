import { describe, expect, it } from "vitest";
import { listApplications, removeApplication, setApplication } from "../src/applications.ts";
import * as schema from "../src/schema.ts";
import { testDb } from "../src/testing.ts";

/** One source and the postings given, each with its id, title and apply link. */
async function seed(db: ReturnType<typeof testDb>, postings: { id: number; applyUrl?: string }[]) {
  await db.insert(schema.sources).values({
    id: "greenhouse:acme",
    platform: "greenhouse",
    key: "acme",
    company: "Acme",
    companySlug: "acme",
    params: {},
  });
  for (const posting of postings) {
    await db.insert(schema.jobs).values({
      id: posting.id,
      sourceId: "greenhouse:acme",
      postingId: String(posting.id),
      company: "Acme",
      companySlug: "acme",
      title: `Role ${posting.id}`,
      url: `https://boards.example/acme/${posting.id}`,
      applyUrl: posting.applyUrl ?? null,
      locationText: "Remote, US",
      excerpt: "x",
      jdHash: "a".repeat(64),
      jdBytes: 1,
      sourceHash: "b".repeat(64),
      facts: {},
      sortAt: 1,
      firstSeenAt: 1,
      updatedAt: 1,
    });
  }
}

describe("applications", () => {
  it("snapshots the posting when first tracked, and returns null for an unknown posting", async () => {
    const db = testDb();
    await seed(db, [{ id: 1, applyUrl: "https://apply.example/1" }, { id: 2 }]);

    expect(await setApplication(db, 99, { status: "saved" }, "me", 5)).toBeNull();
    expect(await setApplication(db, 1, { status: "saved" }, "me", 10)).toEqual({
      jobId: 1,
      status: "saved",
      note: "",
      title: "Role 1",
      company: "Acme",
      location: "Remote, US",
      applyUrl: "https://apply.example/1",
      createdAt: 10,
      updatedAt: 10,
      appliedAt: null,
    });
    // Without an apply link, the posting's own URL is the address to apply through.
    expect((await setApplication(db, 2, { status: "saved" }, "me", 10))?.applyUrl).toBe(
      "https://boards.example/acme/2",
    );
  });

  it("sets applied_at once, on the first move to applied, and keeps it afterwards", async () => {
    const db = testDb();
    await seed(db, [{ id: 1 }]);
    await setApplication(db, 1, { status: "saved" }, "me", 10);

    expect((await setApplication(db, 1, { status: "applied" }, "me", 20))?.appliedAt).toBe(20);
    expect((await setApplication(db, 1, { status: "interviewing" }, "me", 30))?.appliedAt).toBe(20);
    expect(await setApplication(db, 1, { status: "saved" }, "me", 40)).toMatchObject({
      status: "saved",
      appliedAt: 20,
      updatedAt: 40,
    });
    expect((await setApplication(db, 1, { status: "applied" }, "me", 50))?.appliedAt).toBe(20);
  });

  it("starts applied with applied_at when created as applied, and null otherwise", async () => {
    const db = testDb();
    await seed(db, [{ id: 1 }, { id: 2 }]);
    expect((await setApplication(db, 1, { status: "applied" }, "me", 7))?.appliedAt).toBe(7);
    expect((await setApplication(db, 2, { status: "offer" }, "me", 7))?.appliedAt).toBeNull();
  });

  it("keeps the note when omitted and replaces it when given", async () => {
    const db = testDb();
    await seed(db, [{ id: 1 }]);
    await setApplication(db, 1, { status: "saved", note: "Referral from Ana" }, "me", 1);

    expect((await setApplication(db, 1, { status: "applied" }, "me", 2))?.note).toBe(
      "Referral from Ana",
    );
    expect((await setApplication(db, 1, { status: "applied", note: "" }, "me", 3))?.note).toBe("");
  });

  it("lists newest updated first, and removes one role", async () => {
    const db = testDb();
    await seed(db, [{ id: 1 }, { id: 2 }]);
    await setApplication(db, 1, { status: "saved" }, "me", 1);
    await setApplication(db, 2, { status: "saved" }, "me", 2);
    await setApplication(db, 1, { status: "applied" }, "me", 3);

    expect((await listApplications(db)).map((item) => item.jobId)).toEqual([1, 2]);

    await removeApplication(db, 1);
    expect((await listApplications(db)).map((item) => item.jobId)).toEqual([2]);
  });

  it("keeps users apart", async () => {
    const db = testDb();
    await seed(db, [{ id: 1 }]);
    await setApplication(db, 1, { status: "saved", note: "mine" }, "me", 1);
    await setApplication(db, 1, { status: "offer", note: "yours" }, "you", 2);

    expect((await listApplications(db))[0]).toMatchObject({ status: "saved", note: "mine" });
    expect((await listApplications(db, "you"))[0]).toMatchObject({
      status: "offer",
      note: "yours",
    });

    await removeApplication(db, 1, "you");
    expect(await listApplications(db, "you")).toEqual([]);
    expect(await listApplications(db)).toHaveLength(1);
  });
});
