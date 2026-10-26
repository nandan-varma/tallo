import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunIssuesTable } from "../src/components/RunIssuesTable.tsx";
import type { RunRecord } from "../src/lib/status.ts";

const run = (url: string): RunRecord => ({
  id: "run-1",
  sourceId: "greenhouse:acme",
  runnerId: "mac",
  startedAt: 1_800_000_000,
  finishedAt: 1_800_000_060,
  status: "partial",
  seen: 3,
  added: 0,
  changed: 0,
  closed: 0,
  issues: [{ code: "detail", message: "Failed", url }],
});

describe("RunIssuesTable", () => {
  it("links an issue's source only when it is https", () => {
    const safe = renderToStaticMarkup(
      <RunIssuesTable
        runs={[run("https://boards.example.com/jobs/1")]}
        names={{}}
        now={1_800_000_100}
      />,
    );
    expect(safe).toContain('href="https://boards.example.com/jobs/1"');

    const unsafe = renderToStaticMarkup(
      <RunIssuesTable runs={[run("javascript:alert(1)")]} names={{}} now={1_800_000_100} />,
    );
    expect(unsafe).not.toContain("href");
    expect(unsafe).not.toContain("javascript:");
    expect(unsafe).toContain("Failed");
  });
});
