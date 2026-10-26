import type { TextItem } from "pdfjs-dist/types/src/display/api";

/**
 * The text of a PDF, one line per visual line, read in the browser (the file never leaves the device; only
 * this text is sent on). pdf.js is loaded on demand: it is large and only the import step needs it.
 */
export async function extractPdfText(file: File): Promise<string> {
  const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist");
  if (!GlobalWorkerOptions.workerSrc) {
    GlobalWorkerOptions.workerSrc = (
      await import("pdfjs-dist/build/pdf.worker.min.mjs?url")
    ).default;
  }
  const task = getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdf = await task.promise;
  const pages: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    let line = "";
    const lines: string[] = [];
    for (const item of content.items as TextItem[]) {
      line += item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = "";
      }
    }
    if (line) lines.push(line);
    pages.push(lines.map((l) => l.trimEnd()).join("\n"));
  }
  await task.destroy();
  return pages.join("\n\n").trim();
}
