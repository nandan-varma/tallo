import { describe, expect, it } from "vitest";
import { LLMS_EXAMPLES, llmsText } from "../src/llms.ts";
import {
  publicCompanyListSchema,
  publicDescriptionResponseSchema,
  publicErrorSchema,
  publicJobSchema,
  publicSearchPageSchema,
  publicTitleListSchema,
} from "../src/public-api.ts";

describe("llmsText", () => {
  const text = llmsText();

  it("stays under 30 KB, even with the real example answers", () => {
    // The three-line pseudo-shapes were replaced with pretty-printed, schema-valid examples, which is what grew
    // this document past the old 12 KB ceiling.
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(30_000);
  });

  it("embeds one example per endpoint that parses with the response schema", () => {
    const blocks = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
      JSON.parse(String(match[1])),
    );
    expect(blocks).toHaveLength(6);
    const [search, job, description, companies, titles, error] = blocks as unknown[];
    expect(publicSearchPageSchema.parse(search)).toBeTruthy();
    expect(publicJobSchema.parse(job)).toBeTruthy();
    expect(publicDescriptionResponseSchema.parse(description)).toBeTruthy();
    expect(publicCompanyListSchema.parse(companies)).toBeTruthy();
    expect(publicTitleListSchema.parse(titles)).toBeTruthy();
    expect(publicErrorSchema.parse(error)).toBeTruthy();
    // The job example lists the posting itself as a variant, as the route does.
    const parsedJob = publicJobSchema.parse(job);
    expect(parsedJob.variants.map((variant) => variant.id)).toContain(parsedJob.id);
    expect(LLMS_EXAMPLES.job.id).toBe(parsedJob.id);
  });

  it("states the limits an assistant must respect, from the shared constants", () => {
    expect(text).toContain("at most 300 results in total");
    expect(text).toContain("About 60 requests a minute");
    expect(text).toContain("Search limit: 1 to 25, default 10");
    expect(text).toContain("Description chunk: 1 to 8000, default 4000");
    expect(text).not.toMatch(/undefined|\$\{/);
  });

  it("tells the assistant what null means and that pay is only what a source stated", () => {
    expect(text).toContain("pay is only what the source stated");
    expect(text).toContain("null always means unknown");
  });
});
