import { defaultResumeDoc } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { deleteResume, getResume, listResumes, saveResume } from "../src/resume.ts";
import { testDb } from "../src/testing.ts";

const doc = (name: string) => {
  const value = defaultResumeDoc();
  value.resume.name = name;
  return value;
};

describe("resume", () => {
  it("is empty until saved, then round-trips and overwrites", async () => {
    const db = testDb();
    expect(await getResume(db)).toBeNull();

    await saveResume(db, doc("A"), null, "me", 100);
    expect(await getResume(db)).toEqual({ jobId: null, doc: doc("A"), updatedAt: 100 });

    await saveResume(db, doc("B"), null, "me", 200);
    expect((await getResume(db))?.doc.resume.name).toBe("B");
  });

  it("keeps the base copy, tailored copies and users apart", async () => {
    const db = testDb();
    await saveResume(db, doc("base"), null, "me", 1);
    await saveResume(db, doc("for 7"), 7, "me", 2);
    await saveResume(db, doc("other"), null, "you", 3);

    expect((await getResume(db, 7))?.doc.resume.name).toBe("for 7");
    expect((await getResume(db))?.doc.resume.name).toBe("base");
    expect((await getResume(db, null, "you"))?.doc.resume.name).toBe("other");
    expect(await getResume(db, 8)).toBeNull();
  });

  it("lists newest first and deletes one copy", async () => {
    const db = testDb();
    await saveResume(db, doc("base"), null, "me", 1);
    await saveResume(db, doc("for 7"), 7, "me", 2);

    const list = await listResumes(db);
    expect(list.map((item) => item.jobId)).toEqual([7, null]);
    expect(list[0]).toMatchObject({ title: null, company: null });

    await deleteResume(db, 7);
    expect((await listResumes(db)).map((item) => item.jobId)).toEqual([null]);
  });

  it("treats a stored doc that no longer parses as absent", async () => {
    const db = testDb();
    await saveResume(db, { resume: { name: 5 } } as never, null, "me", 1);
    expect(await getResume(db)).toBeNull();
  });
});
