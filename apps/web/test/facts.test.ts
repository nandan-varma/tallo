import { describe, expect, it } from "vitest";
import { readFacts } from "../src/lib/facts.ts";
import {
  extraRows,
  formatExtra,
  formatLocation,
  formatPay,
  formatQuantity,
  sortLocations,
} from "../src/lib/format.ts";

describe("readFacts", () => {
  it("returns empty collections for anything that is not a facts object", () => {
    expect(readFacts(undefined)).toEqual({
      platform: undefined,
      locations: [],
      compensation: [],
      experience: [],
      extras: {},
    });
    expect(readFacts("nope").locations).toEqual([]);
  });

  it("keeps well-formed entries and drops malformed ones", () => {
    const facts = readFacts({
      platform: "greenhouse",
      locations: [
        { text: "Austin, TX", country: "United States", primary: true },
        { city: "x" },
        null,
      ],
      compensation: [
        {
          min: 100,
          max: 120,
          currency: "USD",
          interval: "year",
          component: "base",
          inferred: true,
        },
        { interval: "year" },
        { min: "10" },
      ],
      experience: [
        { min: 3, unit: "years", kind: "required" },
        { min: 3, unit: "decades" },
        { unit: "years" },
      ],
      extras: { team_size: 12 },
    });
    expect(facts.platform).toBe("greenhouse");
    expect(facts.locations).toEqual([
      {
        text: "Austin, TX",
        city: undefined,
        region: undefined,
        country: "United States",
        countryCode: undefined,
        remote: false,
        primary: true,
      },
    ]);
    expect(facts.compensation).toHaveLength(1);
    expect(facts.compensation[0]).toMatchObject({
      min: 100,
      max: 120,
      inferred: true,
      component: "base",
    });
    expect(facts.experience).toEqual([
      expect.objectContaining({ min: 3, unit: "years", kind: "required", inferred: false }),
    ]);
    expect(facts.extras).toEqual({ team_size: 12 });
  });

  it("falls back to unknown enums and stated kind rather than trusting raw strings", () => {
    const [band] = readFacts({
      compensation: [{ min: 1, interval: "fortnight", component: "cash" }],
    }).compensation;
    expect(band).toMatchObject({ interval: "unknown", component: "unknown" });
    const [exp] = readFacts({ experience: [{ min: 2, unit: "years", kind: "weird" }] }).experience;
    expect(exp?.kind).toBe("stated");
  });
});

describe("location formatting", () => {
  it("puts the primary location first, keeping source order otherwise", () => {
    const sorted = sortLocations([{ text: "B" }, { text: "A", primary: true }, { text: "C" }]);
    expect(sorted.map((l) => l.text)).toEqual(["A", "B", "C"]);
  });

  it("appends the country unless the text already names it", () => {
    expect(formatLocation({ text: "London", country: "United Kingdom" })).toBe(
      "London, United Kingdom",
    );
    expect(formatLocation({ text: "Remote - US", countryCode: "US" })).toBe("Remote - US");
    expect(formatLocation({ text: "Berlin" })).toBe("Berlin");
  });

  it("matches country codes exactly, not as substrings", () => {
    expect(formatLocation({ text: "Remote, BUSINESS district", countryCode: "US" })).toBe(
      "Remote, BUSINESS district, US",
    );
    expect(formatLocation({ text: "Campus, Berlin", countryCode: "US" })).toBe(
      "Campus, Berlin, US",
    );
    expect(formatLocation({ text: "Austin, us", countryCode: "US" })).toBe("Austin, us, US");
  });

  it("matches country names whole-word and case-insensitively", () => {
    expect(formatLocation({ text: "london, united kingdom", country: "United Kingdom" })).toBe(
      "london, united kingdom",
    );
    expect(formatLocation({ text: "St. Lucia office", country: "St. Lucia" })).toBe(
      "St. Lucia office",
    );
    expect(formatLocation({ text: "Oman", country: "Man" })).toBe("Oman, Man");
  });
});

describe("pay formatting", () => {
  it("formats ranges, single amounts, interval, component and region", () => {
    expect(
      formatPay({
        min: 120000,
        max: 150000,
        currency: "usd",
        interval: "year",
        component: "base",
        region: "US",
      }),
    ).toBe("$120,000 – $150,000 / yr · Base · US");
  });

  it("says from/up to for open-ended bands instead of showing an exact amount", () => {
    expect(formatPay({ min: 90000, interval: "year", component: "unknown" })).toBe(
      "from 90,000 / yr",
    );
    expect(formatPay({ max: 5000, interval: "once", component: "bonus", currency: "EUR" })).toBe(
      "up to €5,000 one-time · Bonus",
    );
  });

  it("shows a single amount when min equals max and omits unknown labels", () => {
    expect(formatPay({ min: 1000, max: 1000, interval: "unknown", component: "unknown" })).toBe(
      "1,000",
    );
  });

  it("ignores an invalid currency code instead of throwing", () => {
    expect(formatPay({ min: 10, interval: "hour", component: "base", currency: "dollars" })).toBe(
      "from 10 / hr · Base",
    );
  });
});

describe("reversed bands", () => {
  it("drops a pay band whose min is above its max", () => {
    expect(readFacts({ compensation: [{ min: 200, max: 100 }] }).compensation).toEqual([]);
  });

  it("drops an experience range whose min is above its max", () => {
    expect(readFacts({ experience: [{ min: 6, max: 2, unit: "years" }] }).experience).toEqual([]);
  });
});

describe("experience formatting", () => {
  it("never invents a range: min-only is N+, max-only is up to N", () => {
    expect(formatQuantity({ min: 3, unit: "years", kind: "required" })).toBe("3+ years");
    expect(formatQuantity({ min: 1, unit: "years", kind: "preferred" })).toBe("1+ year");
    expect(formatQuantity({ max: 4, unit: "years", kind: "stated" })).toBe("up to 4 years");
    expect(formatQuantity({ min: 2, max: 5, unit: "years", kind: "required" })).toBe("2–5 years");
    expect(formatQuantity({ exact: 6, unit: "months", kind: "stated" })).toBe("6 months");
    expect(formatQuantity({ unit: "years", kind: "stated" })).toBe("");
  });
});

describe("extras formatting", () => {
  it("flattens values to text and drops empty ones", () => {
    expect(formatExtra(["a", "b"])).toBe("a, b");
    expect(formatExtra({ k: 1 })).toBe('{"k":1}');
    expect(formatExtra(null)).toBe("");
    expect(formatExtra(true)).toBe("true");
    expect(
      extraRows({ team_size: 12, empty: null, benefitsList: ["health", null], secretKey: "" }),
    ).toEqual([
      ["Team size", "12"],
      ["Benefits list", "health"],
    ]);
  });
});
