import { describe, expect, it } from "vitest";
import { cleanTitle, prepareJob, sourceLocation } from "../src/index.ts";

const source = { id: "x:y", platform: "x", key: "y", company: "Y", params: {} };
const job = {
  postingId: "1",
  title: "Software Engineer",
  description: "Build things.",
  locations: [sourceLocation("Austin, TX")],
  compensation: [],
  experience: [],
  extras: {},
};
const hash = "a".repeat(64);

describe("cleanTitle", () => {
  it("decodes HTML entities and collapses whitespace", () => {
    expect(cleanTitle("R&amp;D Engineer &amp;lt;tag&amp;gt;")).toBe("R&D Engineer &lt;tag&gt;");
    expect(cleanTitle("Data   Engineer\n(Remote)")).toBe("Data Engineer (Remote)");
  });

  it("keeps short real titles as they are", () => {
    expect(cleanTitle("RN")).toBe("RN");
    expect(cleanTitle("UX")).toBe("UX");
  });
});

describe("prepareJob titles", () => {
  it("stores the decoded title and dedupes escaped and plain copies together", async () => {
    const escaped = await prepareJob({ ...job, title: "R&amp;D Engineer" }, source, hash);
    const plain = await prepareJob({ ...job, title: "R&D Engineer" }, source, hash);
    expect(escaped.facts.title).toBe("R&D Engineer");
    expect(escaped.facts.dedupeKey).toBe(plain.facts.dedupeKey);
  });

  it("records an empty description as empty, with no text invented", async () => {
    const prepared = await prepareJob({ ...job, description: "" }, source, hash);
    expect(prepared.facts.jdBytes).toBe(0);
    expect(prepared.facts.excerpt).toBe("");
  });
});
