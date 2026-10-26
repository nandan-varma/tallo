// @vitest-environment jsdom
import type { Application } from "@tallo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobList } from "@/components/assistant/JobList";

const app = (jobId: number, status: Application["status"], note = ""): Application => ({
  jobId,
  status,
  note,
  title: `Role ${jobId}`,
  company: `Company ${jobId}`,
  location: "Boston, MA",
  applyUrl: `https://example.com/${jobId}`,
  createdAt: 1,
  updatedAt: 1,
  appliedAt: null,
});

let server: Application[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn() as never;
  server = [app(1, "saved", "Ask about on-call"), app(2, "applied")];
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/applications") return Response.json(server);
    const id = Number(url.split("/").pop());
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { status: Application["status"] };
      server = server.map((row) => (row.jobId === id ? { ...row, status: body.status } : row));
      return Response.json(server.find((row) => row.jobId === id));
    }
    if (init?.method === "DELETE") {
      server = server.filter((row) => row.jobId !== id);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(onOpen = vi.fn()) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <JobList
        spec={null}
        notes={new Map()}
        view="tracker"
        onView={() => {}}
        openId={null}
        working={false}
        started={false}
        onOpen={onOpen}
      />
    </QueryClientProvider>,
  );
  return onOpen;
}

describe("tracker list", () => {
  it("lists tracked roles with their status, note and counts, and opens one", async () => {
    const onOpen = mount();
    const list = await screen.findByRole("list", { name: "Tracked roles" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("Ask about on-call")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Saved 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Applied 1" })).toBeTruthy();

    fireEvent.click(within(list).getByText("Role 1"));
    expect(onOpen).toHaveBeenCalledWith("1");
  });

  it("filters by status", async () => {
    mount();
    await screen.findByRole("list", { name: "Tracked roles" });
    fireEvent.click(screen.getByRole("button", { name: "Applied 1" }));
    const list = screen.getByRole("list", { name: "Tracked roles" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("Role 2")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Offer 0" }));
    expect(screen.getByText("Nothing offer")).toBeTruthy();
  });

  it("says so when nothing is tracked", async () => {
    server = [];
    mount();
    expect(await screen.findByText("Nothing tracked yet")).toBeTruthy();
  });

  it("changes a status through the menu and sends it to the server", async () => {
    mount();
    await screen.findByRole("list", { name: "Tracked roles" });
    fireEvent.pointerDown(screen.getByRole("button", { name: /Status: Saved/ }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Interviewing" }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
      expect(put?.[0]).toBe("/api/applications/1");
      expect(JSON.parse(String(put?.[1]?.body))).toMatchObject({ status: "interviewing" });
    });
    expect(await screen.findByRole("button", { name: /Status: Interviewing/ })).toBeTruthy();
  });
});
