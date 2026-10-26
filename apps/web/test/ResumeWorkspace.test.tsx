// @vitest-environment jsdom
import { defaultResumeDoc, type ResumeRecord } from "@tallo/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The PDF engine is covered by resume-render.test; here it is a stub so the workspace can be driven in jsdom.
vi.mock("@/components/resume/PdfPreview", () => ({
  usePreview: (_doc: unknown, enabled: boolean) => ({
    rendered: enabled
      ? {
          pdf: new Uint8Array([1]),
          pages: 1,
          fits: true,
          density: { font: 10.5, line: 1.3, margin: 40, gap: 9 },
        }
      : null,
    busy: false,
    error: null,
  }),
  PdfPages: () => <div data-testid="pdf" />,
}));

import { ResumeWorkspace } from "@/components/resume/ResumeWorkspace";

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const record = (name: string): ResumeRecord => {
  const doc = defaultResumeDoc();
  doc.resume.name = name;
  doc.resume.experience = [
    {
      company: "Acme",
      title: "Engineer",
      location: "",
      start: "2020",
      end: "",
      bullets: ["Built it."],
    },
  ];
  return { jobId: null, doc, updatedAt: 1 };
};

const props = {
  initial: null,
  base: null,
  posting: null,
  copies: [],
  profileText: "",
  autoTailor: false,
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => respond({}));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ResumeWorkspace", () => {
  it("starts with import when there is no resume, and opens a blank editor on request", () => {
    render(<ResumeWorkspace {...props} />);
    expect(screen.getByRole("heading", { name: "Build your resume" })).toBeTruthy();
    expect(screen.queryByLabelText("Full name")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Begin with a blank resume" }));
    expect(screen.getByLabelText("Full name")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Download PDF/ })).toBeTruthy();
  });

  it("offers the profile's resume text as a starting point only when there is one", () => {
    const { rerender } = render(<ResumeWorkspace {...props} />);
    expect(screen.queryByRole("button", { name: "Use my profile’s resume" })).toBeNull();
    rerender(<ResumeWorkspace {...props} profileText={"Jane Roe, engineer. ".repeat(3)} />);
    expect(screen.getByRole("button", { name: "Use my profile’s resume" })).toBeTruthy();
  });

  it("shows the saved resume, starts a posting's copy from the base, and tailors on request", async () => {
    const base = record("Jane Roe");
    const tailored = structuredClone(base.doc.resume);
    tailored.headline = "Platform Engineer";
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/resume/tailor"
        ? respond({ resume: tailored, changes: ["Named the target role"] })
        : respond({ jobId: 5, doc: defaultResumeDoc(), updatedAt: 2 }),
    );
    render(
      <ResumeWorkspace
        {...props}
        initial={null}
        base={base}
        posting={{ id: 5, title: "Platform Engineer", company: "Globex" }}
      />,
    );

    expect((screen.getByLabelText("Full name") as HTMLInputElement).value).toBe("Jane Roe");
    expect(screen.getByText(/This is a new copy for/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Tailor to Platform Engineer at Globex/ }));
    await waitFor(() => expect(screen.getByText("Named the target role")).toBeTruthy());
    expect((screen.getByLabelText("Headline") as HTMLInputElement).value).toBe("Platform Engineer");
    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1].body));
    expect(sent.jobId).toBe(5);

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect((screen.getByLabelText("Headline") as HTMLInputElement).value).toBe("");
    expect(screen.queryByText("Named the target role")).toBeNull();
  });

  it("tailors on arrival when asked to, and says so when it fails", async () => {
    fetchMock.mockResolvedValue(
      respond({ error: "The assistant could not do that. Try again." }, 502),
    );
    render(
      <ResumeWorkspace
        {...props}
        base={record("Jane Roe")}
        posting={{ id: 5, title: "Platform Engineer", company: "Globex" }}
        autoTailor
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("could not do that"),
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/resume/tailor");
  });
});
