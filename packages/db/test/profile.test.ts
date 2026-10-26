import { describe, expect, it } from "vitest";
import { getProfile, saveProfile } from "../src/profile.ts";
import { testDb } from "../src/testing.ts";

describe("profile", () => {
  it("is empty until saved, then round-trips and overwrites", async () => {
    const db = testDb();
    expect(await getProfile(db)).toBeNull();

    await saveProfile(db, { resume: "r1", profile: "# p1" }, "me", 100);
    expect(await getProfile(db)).toEqual({ resume: "r1", profile: "# p1", updatedAt: 100 });

    await saveProfile(db, { resume: "r2", profile: "# p2" }, "me", 200);
    expect(await getProfile(db)).toEqual({ resume: "r2", profile: "# p2", updatedAt: 200 });
  });

  it("keeps users apart", async () => {
    const db = testDb();
    await saveProfile(db, { resume: "a", profile: "A" }, "ann", 1);
    await saveProfile(db, { resume: "b", profile: "B" }, "bob", 2);
    expect((await getProfile(db, "ann"))?.profile).toBe("A");
    expect((await getProfile(db, "bob"))?.profile).toBe("B");
  });
});
