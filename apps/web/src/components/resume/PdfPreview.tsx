import type { ResumeDoc } from "@tallo/contracts";
import { useEffect, useRef, useState } from "react";
import { tidy } from "@/lib/resume/edit";
import { type Rendered, renderResume } from "@/lib/resume/render";

/** Typing pauses this long before the preview is redrawn. */
const PREVIEW_MS = 350;

/**
 * The PDF for the resume as it is now. Redraws when typing pauses; the last good PDF stays on screen while
 * the next one is made, and an error leaves it there too, so the preview never blanks mid-edit.
 */
export function usePreview(doc: ResumeDoc) {
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);

  useEffect(() => {
    const id = ++run.current;
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const next = await renderResume({ resume: tidy(doc.resume), style: doc.style });
        if (id !== run.current) return;
        setRendered(next);
        setError(null);
      } catch (e) {
        if (id === run.current) setError(e instanceof Error ? e.message : "The preview failed.");
      } finally {
        if (id === run.current) setBusy(false);
      }
    }, PREVIEW_MS);
    return () => clearTimeout(timer);
  }, [doc]);

  return { rendered, busy, error };
}

/**
 * Draws a PDF as canvases at the width available. pdf.js is the same renderer on every device (phones do
 * not show PDFs inline), and it loads on first use. Pages are drawn off screen and swapped in together, so
 * a redraw never flashes empty.
 */
export function PdfPages({ pdf }: { pdf: Uint8Array | null }) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      // Ignore sub-pixel jitter; a redraw per pixel of window drag would be wasted work.
      setWidth((current) => (Math.abs(current - next) > 8 ? next : current));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = host.current;
    if (!pdf || !el || width === 0) return;
    let stale = false;
    (async () => {
      const [{ getDocument, GlobalWorkerOptions }, worker] = await Promise.all([
        import("pdfjs-dist"),
        import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
      ]);
      GlobalWorkerOptions.workerSrc ||= worker.default;
      // pdf.js takes ownership of the buffer it is given, so it gets a copy.
      const task = getDocument({ data: pdf.slice() });
      const doc = await task.promise;
      const canvases: HTMLCanvasElement[] = [];
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      for (let n = 1; n <= doc.numPages && !stale; n++) {
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (width / base.width) * ratio });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.className = "block w-full rounded-sm bg-white shadow-sm ring-1 ring-black/5";
        await page.render({ canvas, viewport }).promise;
        canvases.push(canvas);
      }
      await task.destroy();
      if (!stale) el.replaceChildren(...canvases);
    })().catch(() => {
      // A page that fails to draw leaves the previous one; the toolbar still offers the download.
    });
    return () => {
      stale = true;
    };
  }, [pdf, width]);

  return <div ref={host} className="grid w-full gap-4" aria-label="Resume preview" role="img" />;
}
