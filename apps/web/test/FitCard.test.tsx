// @vitest-environment jsdom
import { emptyResume, type Fit } from "@tallo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FitCard } from "@/components/assistant/fit";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const record = {
  jobId: null,
  doc: { resume: { ...emptyResume(), name: "Ada Lovelace" }, style: {}, coverLetter: "" },
  updatedAt: 1,
};

const fit: Fit = {
  verdict: "strong",
  summary: "Strong overlap on TypeScript and API design.",
  matches: [
    { requirement: "5+ years of TypeScript", evidence: "Five years writing TypeScript services" },
  ],
  gaps: [{ requirement: "Kubernetes", advice: "Mention any container work you have done." }],
};

function mount(answer: (url: string, init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => answer(url, init));
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <FitCard jobId={42} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Check my fit" }));
  return fetchMock;
}

describe("FitCard", () => {
  it("reads the base resume, posts it with the job, and shows the verdict with its quotes", async () => {
    const fetchMock = mount((url) => Response.json(url === "/api/resume/fit" ? fit : record));

    expect(await screen.findByText("Strong fit")).toBeTruthy();
    expect(screen.getByText("Strong overlap on TypeScript and API design.")).toBeTruthy();
    expect(screen.getByText("5+ years of TypeScript")).toBeTruthy();
    expect(screen.getByText("Five years writing TypeScript services")).toBeTruthy();
    expect(screen.getByText("Kubernetes")).toBeTruthy();
    expect(screen.getByText("Mention any container work you have done.")).toBeTruthy();

    const [first, second] = fetchMock.mock.calls;
    expect(first[0]).toBe("/api/resume");
    expect(second[0]).toBe("/api/resume/fit");
    expect(second[1]?.method).toBe("POST");
    const body = JSON.parse(String(second[1]?.body));
    expect(body.jobId).toBe(42);
    expect(body.resume.name).toBe("Ada Lovelace");

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("button", { name: "Check my fit" })).toBeTruthy();
  });

  it("asks for a resume first and does not call the fit endpoint when there is none", async () => {
    const fetchMock = mount(() => Response.json(null));

    expect(await screen.findByText("Add your resume first.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open your resume" }).getAttribute("href")).toBe(
      "/resume",
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/resume/fit")).toBe(false);
  });

  it("shows the server's error message and offers a retry", async () => {
    mount((url) =>
      url === "/api/resume/fit"
        ? Response.json({ error: "The assistant is busy. Try again in a minute." }, { status: 503 })
        : Response.json(record),
    );

    expect(await screen.findByText("The assistant is busy. Try again in a minute.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
