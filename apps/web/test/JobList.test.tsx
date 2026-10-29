// @vitest-environment jsdom
import type { JobHit } from "@tallo/search-ai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { JobList } from "@/components/assistant/JobList";

const hit = (id: number): JobHit => ({
  id: String(id),
  title: `Reviewed Engineer ${id}`,
  company: "Acme",
  location: "Seattle, WA",
  workMode: null,
  pay: null,
  postedAt: null,
  department: null,
  locations: 1,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("paginates reviewed jobs after leaving a saved discovery search with cached placeholder data", async () => {
  Element.prototype.scrollTo = vi.fn() as never;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      Response.json(url === "/api/search" ? { hits: [hit(99)], nextOffset: null } : []),
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rows = Array.from({ length: 25 }, (_, i) => hit(i + 1));
  const list = (discovery: boolean) => (
    <QueryClientProvider client={client}>
      <JobList
        spec={{ queries: ["software engineer"] }}
        discovery={discovery}
        reviewed={discovery ? null : rows}
        notes={new Map()}
        view="results"
        onView={() => {}}
        openId={null}
        working={false}
        started
        onOpen={() => {}}
      />
    </QueryClientProvider>
  );
  const view = render(list(true));
  await screen.findByText("Reviewed Engineer 99");
  view.rerender(list(false));
  expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false);
  expect(screen.getByRole("list", { name: "Search results" }).className).not.toContain(
    "opacity-60",
  );
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  const results = screen.getByRole("list", { name: "Search results" });
  expect(within(results).getAllByRole("button")).toHaveLength(5);
  expect(within(results).getByText("Reviewed Engineer 21")).toBeTruthy();
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/search")).toHaveLength(1);
});
