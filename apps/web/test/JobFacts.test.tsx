import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JobFacts } from "../src/components/JobFacts.tsx";

const render = (facts: Record<string, unknown>) => renderToStaticMarkup(<JobFacts facts={facts} />);

describe("JobFacts", () => {
  it("renders nothing when there is no known fact", () => {
    expect(render({})).toBe("");
    expect(render({ platform: "greenhouse", locations: [], compensation: [] })).toBe("");
    expect(render({ extras: { empty: null, blank: "" } })).toBe("");
  });

  it("renders a Facts heading with a section heading per populated group", () => {
    const html = render({
      locations: [{ text: "Austin, TX", country: "United States", primary: true, remote: true }],
      compensation: [
        { min: 120000, max: 150000, currency: "USD", interval: "year", component: "base" },
      ],
      experience: [{ min: 3, unit: "years", kind: "required" }],
      extras: { team_size: 12 },
    });
    expect(html).toContain('<h2 id="job-facts-heading"');
    expect(html).toContain(">Facts</h2>");
    for (const title of ["Locations", "Pay", "Experience", "Source details"]) {
      expect(html).toContain(`<h3 class="text-sm font-medium">${title}</h3>`);
    }
    expect(html).toContain("Austin, TX, United States");
    expect(html).toContain("$120,000 – $150,000 / yr · Base");
    expect(html).toContain("3+ years");
    expect(html).toContain("Team size");
    expect(html).toContain(">Primary<");
    expect(html).toContain(">Remote<");
  });

  it("omits sections with no data", () => {
    const html = render({ compensation: [{ min: 90000, interval: "year", component: "unknown" }] });
    expect(html).toContain("from 90,000 / yr");
    expect(html).toContain(">Pay</h3>");
    expect(html).not.toContain("Locations</h3>");
    expect(html).not.toContain("Experience</h3>");
    expect(html).not.toContain("Source details</h3>");
  });

  it("marks inferred values with a from text badge and leaves structured values unmarked", () => {
    const html = render({
      compensation: [
        { min: 100, max: 120, interval: "year", component: "base", inferred: true },
        { min: 200, max: 240, interval: "year", component: "base" },
      ],
      experience: [{ min: 5, unit: "years", kind: "required", inferred: true }],
    });
    expect(html.split("from text").length - 1).toBe(2);
  });

  it("drops malformed and reversed entries instead of rendering them", () => {
    const html = render({
      compensation: [
        { min: 300, max: 100, interval: "year", component: "base" },
        { interval: "year" },
      ],
      experience: [
        { min: 9, max: 2, unit: "years" },
        { min: 4, unit: "decades" },
      ],
    });
    expect(html).toBe("");
  });
});
