// @vitest-environment jsdom
import type { JobHit } from "@tallo/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { JobResults } from "@/components/JobResults";

afterEach(cleanup);

const hit = (overrides: Partial<JobHit> & { id: string }): JobHit => ({
  title: "Data Engineer",
  company: "Acme",
  location: "Seattle, WA",
  workMode: "hybrid",
  pay: "USD 150000-180000 per year",
  compensation: [
    { min: 150000, max: 180000, currency: "USD", interval: "year", component: "base" },
  ],
  postedAt: "2026-10-20",
  department: null,
  employmentType: null,
  countryCode: null,
  applyUrl: `https://boards.example.com/acme/apply/${overrides.id}`,
  sourceLastListedAt: "2026-11-20T00:00:00.000Z",
  locations: 1,
  ...overrides,
});

describe("JobResults", () => {
  it("links each title to the employer's application and shows its facts", () => {
    render(<JobResults hits={[hit({ id: "1" })]} start={1} prevHref={null} nextHref={null} />);

    const link = screen.getByRole("link", { name: "Data Engineer" });
    expect(link.getAttribute("href")).toBe("https://boards.example.com/acme/apply/1");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(
      screen.getByText(/Acme · Seattle, WA · hybrid · USD 150,000\u2013180,000 a year/),
    ).toBeTruthy();
    expect(screen.getByText("Showing 1–1")).toBeTruthy();
  });

  it("shows a title without a link when the apply address is not a web link", () => {
    render(
      <JobResults
        hits={[hit({ id: "2", applyUrl: "javascript:alert(1)" })]}
        start={1}
        prevHref={null}
        nextHref={null}
      />,
    );

    expect(screen.queryByRole("link", { name: "Data Engineer" })).toBeNull();
    expect(screen.getByText("Data Engineer")).toBeTruthy();
  });

  it("says how many locations the role is open in, when it is more than one", () => {
    render(
      <JobResults
        hits={[hit({ id: "3", locations: 4 })]}
        start={1}
        prevHref={null}
        nextHref={null}
      />,
    );
    expect(screen.getByText(/4 locations/)).toBeTruthy();
  });

  it("offers previous and next links only where a page exists", () => {
    const { rerender } = render(
      <JobResults
        hits={[hit({ id: "4" })]}
        start={21}
        prevHref="/search?title=data+engineer"
        nextHref="/search?title=data+engineer&offset=40"
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Pages" });
    expect(within(nav).getByRole("link", { name: "Previous" }).getAttribute("href")).toBe(
      "/search?title=data+engineer",
    );
    expect(within(nav).getByRole("link", { name: "Next" }).getAttribute("href")).toBe(
      "/search?title=data+engineer&offset=40",
    );

    rerender(<JobResults hits={[hit({ id: "4" })]} start={1} prevHref={null} nextHref={null} />);
    expect(screen.queryByRole("link", { name: "Next" })).toBeNull();
  });

  it("says so when nothing matched", () => {
    render(<JobResults hits={[]} start={1} prevHref={null} nextHref={null} />);
    expect(screen.getByText("No postings match that search.")).toBeTruthy();
  });
});
