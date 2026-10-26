// @vitest-environment jsdom
import type { defaultResumeDoc } from "@tallo/contracts";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOSAVE_MS, useResumeDoc } from "@/components/resume/useResumeDoc";

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
    respond({ jobId: null, doc: JSON.parse(String(init.body)), updatedAt: 42 }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const rename = (name: string) => (d: ReturnType<typeof defaultResumeDoc>) => ({
  ...d,
  resume: { ...d.resume, name },
});

describe("useResumeDoc", () => {
  it("writes nothing until the first edit, then saves once typing pauses", async () => {
    const { result } = renderHook(() => useResumeDoc({ jobId: null, initial: null }));
    await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2));
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => result.current.edit(rename("A")));
    act(() => result.current.edit(rename("Ad")));
    expect(result.current.state).toBe("unsaved");
    await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_MS));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/resume");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1].body)).resume.name).toBe("Ad");
    expect(result.current.state).toBe("saved");
    expect(result.current.savedAt).toBe(42);
  });

  it("addresses the tailored copy by posting id", async () => {
    const { result } = renderHook(() => useResumeDoc({ jobId: 7, initial: null }));
    act(() => result.current.edit(rename("A")));
    await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_MS));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/resume?job=7");
  });

  it("saves an edit that lands while a write is in flight", async () => {
    let release: () => void = () => {};
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve) => {
          release = () => resolve(respond({ doc: JSON.parse(String(init.body)), updatedAt: 1 }));
        }),
    );
    const { result } = renderHook(() => useResumeDoc({ jobId: null, initial: null }));
    act(() => result.current.edit(rename("A")));
    await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_MS));
    act(() => result.current.edit(rename("AB")));
    await act(async () => release());
    expect(result.current.state).toBe("unsaved");

    await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_MS));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1].body)).resume.name).toBe("AB");
    expect(result.current.state).toBe("saved");
  });

  it("reports a failed write and recovers on retry", async () => {
    fetchMock.mockResolvedValueOnce(respond({ error: "Nope" }, 500));
    const { result } = renderHook(() => useResumeDoc({ jobId: null, initial: null }));
    act(() => result.current.edit(rename("A")));
    await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_MS));
    expect(result.current.state).toBe("error");
    expect(result.current.error).toBe("Nope");

    await act(() => result.current.retry());
    expect(result.current.state).toBe("saved");
  });

  it("keeps the previous resume for an AI change and restores it on undo", async () => {
    const { result } = renderHook(() => useResumeDoc({ jobId: null, initial: null }));
    act(() => result.current.edit(rename("Before")));
    const after = { ...result.current.doc.resume, name: "After" };
    act(() => result.current.applyAi(after, ["Renamed"], "edit"));
    expect(result.current.doc.resume.name).toBe("After");
    expect(result.current.review).toMatchObject({ changes: ["Renamed"], kind: "edit" });

    act(() => result.current.undoAi());
    expect(result.current.doc.resume.name).toBe("Before");
    expect(result.current.review).toBeNull();
  });
});
