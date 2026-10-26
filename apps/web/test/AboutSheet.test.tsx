// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AboutSheet } from "@/components/assistant/AboutSheet";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(hasResume: boolean, stored: unknown) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    Response.json(init?.method === "PUT" ? { ok: true } : stored),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AboutSheet hasResume={hasResume} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "About you" }));
  return fetchMock;
}

describe("AboutSheet", () => {
  it("loads the saved notes, saves an edit, and links to the resume", async () => {
    const fetchMock = mount(true, { profile: "Remote only.", resume: "", updatedAt: 1 });
    const box = (await screen.findByLabelText(/Target roles/)) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("Remote only."));
    expect(screen.getByRole("link", { name: "resume" }).getAttribute("href")).toBe("/resume");

    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(box, { target: { value: "Remote or Boston." } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(put?.[0]).toBe("/api/profile");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ profile: "Remote or Boston." });
  });

  it("asks for a resume first when there is none", async () => {
    mount(false, null);
    expect(await screen.findByRole("link", { name: "Add your resume" })).toBeTruthy();
  });
});
