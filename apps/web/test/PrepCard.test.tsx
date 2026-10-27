// @vitest-environment jsdom
import { emptyResume, type Prep } from "@tallo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrepCard } from "@/components/assistant/prep";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const record = {
  jobId: null,
  doc: { resume: { ...emptyResume(), name: "Ada Lovelace" }, style: {}, coverLetter: "" },
  updatedAt: 1,
};

const prep: Prep = {
  questions: [
    {
      question: "Tell me about a time you scaled an API.",
      angle: "Lead with the Go service and the latency it saved.",
      evidence: "Built a Go service that cut p95 latency.",
    },
    {
      question: "How would you run Kubernetes in production?",
      angle: "Not in your resume; say what you have seen and how you would learn it.",
      evidence: "",
    },
  ],
  ask: ["How is the API latency budget set for this team?"],
};

function mount(answer: (url: string, init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => answer(url, init));
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PrepCard jobId={42} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Prepare me" }));
  return fetchMock;
}

describe("PrepCard", () => {
  it("reads the base resume, posts it with the job, and shows the questions and questions to ask", async () => {
    const fetchMock = mount((url) => Response.json(url === "/api/resume/prep" ? prep : record));

    expect(await screen.findByText("Tell me about a time you scaled an API.")).toBeTruthy();
    expect(screen.getByText("Lead with the Go service and the latency it saved.")).toBeTruthy();
    expect(screen.getByText("Built a Go service that cut p95 latency.")).toBeTruthy();
    expect(screen.getByText("How would you run Kubernetes in production?")).toBeTruthy();
    expect(screen.getByText("Questions to ask them")).toBeTruthy();
    expect(screen.getByText("How is the API latency budget set for this team?")).toBeTruthy();

    const [first, second] = fetchMock.mock.calls;
    expect(first[0]).toBe("/api/resume");
    expect(second[0]).toBe("/api/resume/prep");
    expect(second[1]?.method).toBe("POST");
    const body = JSON.parse(String(second[1]?.body));
    expect(body.jobId).toBe(42);
    expect(body.resume.name).toBe("Ada Lovelace");

    fireEvent.click(screen.getByRole("button", { name: "Prepare again" }));
    expect(await screen.findByRole("button", { name: "Prepare me" })).toBeTruthy();
  });

  it("asks for a resume first and does not call the prep endpoint when there is none", async () => {
    const fetchMock = mount(() => Response.json(null));

    expect(await screen.findByText("Add your resume first.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open your resume" }).getAttribute("href")).toBe(
      "/resume",
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/resume/prep")).toBe(false);
  });

  it("shows the server's error message and offers a retry", async () => {
    mount((url) =>
      url === "/api/resume/prep"
        ? Response.json({ error: "The assistant is busy. Try again in a minute." }, { status: 503 })
        : Response.json(record),
    );

    expect(await screen.findByText("The assistant is busy. Try again in a minute.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
