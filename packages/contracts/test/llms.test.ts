import { describe, expect, it } from "vitest";
import { llmsText } from "../src/llms.ts";

describe("llmsText", () => {
  const text = llmsText();

  it("stays under 5 KB, so an assistant can read all of it in one fetch", () => {
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(5000);
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
