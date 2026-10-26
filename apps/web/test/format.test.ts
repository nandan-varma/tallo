import { describe, expect, it } from "vitest";
import { ago, experience, salary } from "../src/lib/format.ts";

describe("format", () => {
  it("formats pay bands and single values, and hides unknown pay", () => {
    expect(
      salary({ salaryMinAnnual: 120000, salaryMaxAnnual: 150000, salaryCurrency: "USD" }),
    ).toBe("$120K – $150K / yr");
    expect(salary({ salaryMinAnnual: 90000, salaryMaxAnnual: null, salaryCurrency: "USD" })).toBe(
      "$90K / yr",
    );
    expect(
      salary({ salaryMinAnnual: null, salaryMaxAnnual: null, salaryCurrency: null }),
    ).toBeNull();
  });
  it("describes age and experience", () => {
    expect(ago(1000, 1000 + 3 * 86400)).toBe("3d ago");
    expect(ago(1000, 1000 + 40 * 86400)).toBe("1mo ago");
    expect(ago(null)).toBeNull();
    expect(ago(1000, 1010)).toBe("just now");
    expect(ago(1000, 1000 + 5 * 60)).toBe("5m ago");
    expect(ago(1000, 1000 + 3 * 3600 + 59)).toBe("3h ago");
    expect(ago(2000, 1000)).toBe("just now");
    expect(experience(5)).toBe("5+ yrs");
    expect(experience(null)).toBeNull();
  });
});
