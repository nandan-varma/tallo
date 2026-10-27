import { describe, expect, it } from "vitest";
import { type Money, payText } from "../src/job.ts";

const base = (over: Partial<Money>): Money => ({
  min: 90000,
  max: 95000,
  currency: "USD",
  interval: "year",
  component: "base",
  ...over,
});

describe("payText", () => {
  it("states the band in the source's own interval, with its currency", () => {
    expect(payText([base({ interval: "hour" })])).toBe("USD 90000-95000 per hour");
    expect(payText([base({ interval: "year" })])).toBe("USD 90000-95000 per year");
  });

  it("writes a single amount, a min-only band and a max-only band plainly", () => {
    expect(payText([base({ max: 90000 })])).toBe("USD 90000 per year");
    expect(payText([base({ max: undefined })])).toBe("USD 90000+ per year");
    expect(payText([base({ min: undefined })])).toBe("USD up to 95000 per year");
  });

  it("drops the currency when the source gives none", () => {
    expect(payText([base({ currency: undefined })])).toBe("90000-95000 per year");
  });

  it("adds a region the band is scoped to", () => {
    expect(payText([base({ region: "US" })])).toBe("USD 90000-95000 per year (US)");
  });

  it("uses only stated base pay with a rate interval", () => {
    expect(payText(undefined)).toBeNull();
    expect(payText([])).toBeNull();
    expect(payText([base({ component: "bonus" })])).toBeNull();
    expect(payText([base({ interval: "once" })])).toBeNull();
    expect(payText([base({ interval: "unknown" })])).toBeNull();
    expect(payText([base({ inferred: true })])).toBeNull();
    expect(payText([base({ min: undefined, max: undefined })])).toBeNull();
  });

  it("picks the first usable band, skipping ones it must not use", () => {
    expect(
      payText([
        base({ component: "equity" }),
        base({ inferred: true, min: 1, max: 2 }),
        base({ min: 60, max: 70, interval: "hour" }),
      ]),
    ).toBe("USD 60-70 per hour");
  });
});
