// @vitest-environment jsdom
import type { JobHit } from "@tallo/search-ai";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { JobRow } from "../src/components/assistant/JobRow.tsx";

const hit = (over: Partial<JobHit> = {}): JobHit => ({
  id: "1",
  title: "Data Engineer",
  company: "Acme",
  location: "Seattle, WA",
  workMode: "onsite",
  pay: null,
  postedAt: null,
  department: null,
  locations: 1,
  ...over,
});

afterEach(cleanup);

describe("JobRow", () => {
  it("labels a role open in several places with its location count", () => {
    render(<JobRow hit={hit({ locations: 12 })} active={false} onOpen={() => {}} />);
    expect(screen.getByText("12 locations")).toBeTruthy();
  });

  it("says nothing about locations for a role in one place", () => {
    render(<JobRow hit={hit({ locations: 1 })} active={false} onOpen={() => {}} />);
    expect(screen.queryByText(/locations$/)).toBeNull();
  });
});
