import { describe, expect, it } from "vitest";
import { openApiDocument } from "../src/openapi.ts";
import {
  decodeCursor,
  descriptionChunk,
  encodeCursor,
  PUBLIC_PATHS,
  publicDescriptionSchema,
  publicSearchSchema,
  searchNote,
} from "../src/public-api.ts";

const query = {
  title: ["backend engineer"],
  company: [],
  location: ["remote"],
  country: [],
  sort: "relevance" as const,
};

describe("search cursor", () => {
  it("round-trips the offset for the same query", () => {
    for (const offset of [0, 1, 20, 299]) {
      expect(decodeCursor(encodeCursor(query, offset), query)).toBe(offset);
    }
  });

  it("is opaque text, URL-safe with no padding", () => {
    const cursor = encodeCursor(query, 20);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain("=");
  });

  it("is bound to the query, so a cursor cannot page another search", () => {
    const cursor = encodeCursor(query, 20);
    expect(decodeCursor(cursor, { ...query, title: ["platform engineer"] })).toBeNull();
    expect(decodeCursor(cursor, { ...query, company: ["Stripe"] })).toBeNull();
    expect(decodeCursor(cursor, { ...query, location: ["NYC"] })).toBeNull();
  });

  it("is bound to the sort, so a cursor cannot switch order", () => {
    const cursor = encodeCursor(query, 20);
    expect(decodeCursor(cursor, { ...query, sort: "recent" })).toBeNull();
    expect(decodeCursor(cursor, { ...query, sort: "posted" })).toBeNull();
    expect(decodeCursor(cursor, { ...query, sort: "added" })).toBeNull();
    expect(decodeCursor(encodeCursor({ ...query, sort: "recent" }, 20), query)).toBeNull();
  });

  it("is bound to country and postedWithin, so a cursor cannot change a filter", () => {
    const filtered = { ...query, country: ["US"], postedWithin: 30 };
    const cursor = encodeCursor(filtered, 20);
    expect(decodeCursor(cursor, filtered)).toBe(20);
    expect(decodeCursor(cursor, { ...filtered, country: ["CA"] })).toBeNull();
    expect(decodeCursor(cursor, { ...filtered, country: [] })).toBeNull();
    expect(decodeCursor(cursor, { ...filtered, postedWithin: 7 })).toBeNull();
    expect(decodeCursor(cursor, { ...filtered, postedWithin: undefined })).toBeNull();
    expect(
      decodeCursor(encodeCursor({ ...filtered, postedWithin: undefined }, 20), filtered),
    ).toBeNull();
  });

  it("accepts only the one spelling of each cursor, so no edit of its last character passes", () => {
    const cursor = encodeCursor(query, 20);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (const c of alphabet) {
      const edited = cursor.slice(0, -1) + c;
      if (edited === cursor) continue;
      expect(decodeCursor(edited, query), edited).toBeNull();
    }
  });

  it("rejects a tampered, malformed or out-of-range cursor", () => {
    const cursor = encodeCursor(query, 20);
    const flipped = cursor.slice(0, -1) + (cursor.endsWith("A") ? "B" : "A");
    expect(decodeCursor(flipped, query)).toBeNull();
    for (const bad of ["", "abc", "not a cursor", "%%%", "MjA"]) {
      expect(decodeCursor(bad, query), bad).toBeNull();
    }
    // A well-formed cursor past the cap (offset 300) is refused even when its checksum is valid.
    const past = encodeCursor(query, 300);
    expect(decodeCursor(past, query)).toBeNull();
  });
});

describe("descriptionChunk", () => {
  it("cuts at the limit and reports where the next chunk starts", () => {
    expect(descriptionChunk("abcdefghij", 0, 4)).toEqual({ text: "abcd", next: 4 });
    expect(descriptionChunk("abcdefghij", 8, 4)).toEqual({ text: "ij", next: null });
    expect(descriptionChunk("abcdefghij", 10, 4)).toEqual({ text: "", next: null });
  });

  it("never splits a surrogate pair, and always makes progress", () => {
    const text = "a\u{1F600}b"; // "a", a two-unit emoji, "b"
    // A cut that would land inside the emoji moves away from it.
    const first = descriptionChunk(text, 0, 2);
    expect(first.text).toBe("a");
    expect(first.next).toBe(1);
    const second = descriptionChunk(text, 1, 1);
    expect(second.text).toBe("\u{1F600}");
    expect(second.next).toBe(3);
    // Walking any limit joins back to the whole text.
    for (const limit of [1, 2, 3]) {
      let offset: number | null = 0;
      let joined = "";
      for (let guard = 0; offset !== null && guard < 10; guard++) {
        const chunk = descriptionChunk(text, offset, limit);
        joined += chunk.text;
        offset = chunk.next;
      }
      expect(joined, `limit ${limit}`).toBe(text);
    }
  });

  it("without a limit, everything from the offset to the end comes back", () => {
    const text = "x".repeat(20000);
    expect(descriptionChunk(text, 0)).toEqual({ text, next: null });
    expect(descriptionChunk(text, 15000).text).toHaveLength(5000);
  });
});

describe("search query schema", () => {
  const parse = (input: unknown) => publicSearchSchema.safeParse(input);

  it("defaults the limit to 10 and the optional lists to empty", () => {
    const result = parse({ title: ["backend engineer"] });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      title: ["backend engineer"],
      company: [],
      location: [],
      country: [],
      sort: "relevance",
      limit: 10,
    });
  });

  it("accepts the four sort modes, defaults to relevance and refuses any other", () => {
    for (const sort of ["relevance", "recent", "posted", "added"]) {
      expect(parse({ title: ["ab"], sort }).data?.sort).toBe(sort);
    }
    expect(parse({ title: ["ab"] }).data?.sort).toBe("relevance");
    expect(parse({ title: ["ab"], sort: "newest" }).success).toBe(false);
    expect(parse({ title: ["ab"], sort: "RELEVANCE" }).success).toBe(false);
  });

  it("trims values and refuses ones with no letter or digit", () => {
    expect(parse({ title: ["  backend engineer  "] }).data?.title).toEqual(["backend engineer"]);
    expect(parse({ title: ["!!"] }).success).toBe(false);
    expect(parse({ title: ["ab"], location: ["x"] }).success).toBe(false);
  });

  it("coerces a numeric limit from the URL and refuses out-of-range ones", () => {
    expect(parse({ title: ["ab"], limit: "25" }).data?.limit).toBe(25);
    expect(parse({ title: ["ab"], limit: "26" }).success).toBe(false);
    expect(parse({ title: ["ab"], limit: "0" }).success).toBe(false);
    expect(parse({ title: ["ab"], limit: "2.5" }).success).toBe(false);
  });

  it("normalizes country codes to uppercase and refuses anything but two letters", () => {
    expect(parse({ title: ["ab"], country: ["us", "Ca"] }).data?.country).toEqual(["US", "CA"]);
    expect(parse({ title: ["ab"], country: ["USA"] }).success).toBe(false);
    expect(parse({ title: ["ab"], country: ["U1"] }).success).toBe(false);
    expect(parse({ title: ["ab"], country: ["U"] }).success).toBe(false);
    expect(
      parse({ title: ["ab"], country: ["US", "CA", "DE", "FR", "ES", "IT", "NL", "SE", "NO"] })
        .success,
    ).toBe(false);
  });

  it("coerces postedWithin to whole days from 1 to 365 and leaves it unset by default", () => {
    expect(parse({ title: ["ab"] }).data).not.toHaveProperty("postedWithin");
    expect(parse({ title: ["ab"], postedWithin: "30" }).data?.postedWithin).toBe(30);
    expect(parse({ title: ["ab"], postedWithin: 1 }).data?.postedWithin).toBe(1);
    expect(parse({ title: ["ab"], postedWithin: 365 }).data?.postedWithin).toBe(365);
    for (const bad of ["0", "366", "1.5", "abc", "-1"])
      expect(parse({ title: ["ab"], postedWithin: bad }).success, bad).toBe(false);
  });

  it("describes every field, so llms.txt can say what each one takes", () => {
    for (const [name, field] of Object.entries(publicSearchSchema.shape)) {
      expect(field.description, name).toEqual(expect.any(String));
    }
  });
});

describe("description query schema", () => {
  it("reads the rest from the offset unless a limit is given", () => {
    expect(publicDescriptionSchema.parse({})).toEqual({ offset: 0 });
    expect(publicDescriptionSchema.parse({ limit: "50000" })).toEqual({ offset: 0, limit: 50000 });
    expect(publicDescriptionSchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(publicDescriptionSchema.safeParse({ offset: "-1" }).success).toBe(false);
  });
});

describe("searchNote", () => {
  it("says what the list is and whether there is more", () => {
    expect(searchNote({ count: 0, hasMore: false, capped: false, offset: 0 })).toContain(
      "No open postings",
    );
    expect(searchNote({ count: 3, hasMore: true, capped: false, offset: 0 })).toContain(
      "next as cursor",
    );
    expect(searchNote({ count: 3, hasMore: false, capped: false, offset: 0 })).toContain(
      "last page",
    );
    expect(searchNote({ count: 0, hasMore: false, capped: false, offset: 10 })).toContain(
      "No more open postings",
    );
    expect(searchNote({ count: 0, hasMore: false, capped: true, offset: 300 })).toContain(
      "no page at offset 300",
    );
    expect(searchNote({ count: 10, hasMore: false, capped: true, offset: 290 })).toContain(
      "300-result cap",
    );
  });
});

describe("search schema", () => {
  it("accepts a company without a title, but neither alone is not enough", () => {
    expect(publicSearchSchema.parse({ company: ["Stripe"] }).title).toEqual([]);
    expect(publicSearchSchema.parse({ title: ["backend engineer"] }).company).toEqual([]);
    expect(publicSearchSchema.safeParse({}).success).toBe(true);
  });
});

describe("openapi", () => {
  it("documents every public path and derives the response components", () => {
    const doc = openApiDocument() as {
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    for (const path of PUBLIC_PATHS) expect(doc.paths[path.replace(":id", "{id}")]).toBeDefined();
    const search = doc.paths["/v1/search"] as {
      get: { parameters: { name: string; schema: { enum?: string[] } }[] };
    };
    const sort = search.get.parameters.find((parameter) => parameter.name === "sort");
    expect(sort?.schema.enum).toEqual(["relevance", "recent", "posted", "added"]);
    for (const name of [
      "PublicError",
      "JobHit",
      "PublicSearchPage",
      "PublicJob",
      "PublicDescriptionResponse",
      "PublicCompanyList",
      "PublicTitleList",
    ])
      expect(doc.components.schemas[name]).toBeDefined();
  });

  it("describes every response field, and says the posting's description comes whole", () => {
    const doc = openApiDocument() as {
      paths: Record<string, { get: { summary: string } }>;
      components: {
        schemas: Record<string, { properties: Record<string, { description?: string }> }>;
      };
    };
    expect(doc.paths["/v1/jobs/{id}"]?.get.summary).toContain("whole description");
    for (const name of ["JobHit", "PublicSearchPage", "PublicJob", "PublicDescriptionResponse"]) {
      const properties = doc.components.schemas[name]?.properties ?? {};
      // Only the version literal and the plain identifiers may go without a description.
      const bare = Object.entries(properties)
        .filter(([key, field]) => !field.description && !["apiVersion", "id"].includes(key))
        .map(([key]) => key);
      expect(bare, `${name} fields without a description`).toEqual([]);
    }
  });

  it("carries the field-availability caveat on countryCode and postedAt", () => {
    const doc = openApiDocument() as {
      components: {
        schemas: Record<string, { properties: Record<string, { description?: string }> }>;
      };
    };
    for (const name of ["JobHit", "PublicJob"]) {
      const properties = doc.components.schemas[name]?.properties;
      expect(properties?.countryCode?.description, name).toContain("partial");
      expect(properties?.countryCode?.description, name).toContain("never inferred");
      expect(properties?.postedAt?.description, name).toContain("never guessed");
      for (const field of [
        "pay",
        "compensation",
        "workMode",
        "employmentType",
        "sourceLastListedAt",
        "location",
        "department",
      ]) {
        expect(properties?.[field]?.description, `${name}.${field}`).toEqual(expect.any(String));
      }
    }
  });
});
