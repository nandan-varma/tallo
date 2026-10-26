import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JobExplorer } from "../src/components/JobExplorer.tsx";

describe("JobExplorer", () => {
  it("renders the search page without facets (facets endpoint unavailable)", () => {
    const html = renderToStaticMarkup(<JobExplorer jobs={[]} nextCursor={null} values={{}} />);
    expect(html).toContain('aria-label="Job filters"');
  });
});
