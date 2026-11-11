// @vitest-environment jsdom
import type { JobHit } from "@tallo/contracts";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, it } from "vitest";
import { JobResults } from "@/components/JobResults";
import { SearchForm } from "@/components/SearchForm";
import { expectNoViolations } from "./a11y.ts";

afterEach(cleanup);

const hit: JobHit = {
  id: "1",
  title: "Data Engineer",
  company: "Acme",
  location: "Seattle, WA",
  workMode: "hybrid",
  pay: "USD 150000-180000 per year",
  postedAt: "2026-10-20",
  department: "Data",
  applyUrl: "https://boards.example.com/acme/apply/1",
  locations: 2,
};

describe("accessibility", () => {
  it("the search form has no violations", async () => {
    const { container } = render(
      <SearchForm values={{ title: "data engineer", company: "", location: "" }} />,
    );
    await expectNoViolations(container);
  });

  it("the results list has no violations", async () => {
    const { container } = render(
      <JobResults
        hits={[hit]}
        start={1}
        prevHref={null}
        nextHref="/search?title=data+engineer&offset=20"
      />,
    );
    await expectNoViolations(container);
  });
});
