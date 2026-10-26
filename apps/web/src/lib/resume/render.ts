import type { ResumeDoc } from "@tallo/contracts";
import { createElement } from "react";
import { DENSITIES, type Density, pageCount } from "@/lib/resume/layout";

export interface Rendered {
  pdf: Uint8Array;
  pages: number;
  density: Density;
  /** False when even the tightest density needs more pages than the budget; the resume is too long. */
  fits: boolean;
}

/** Index of the density in `DENSITIES` to render with. */
async function renderAt(doc: ResumeDoc, density: Density) {
  // Loaded on first use: the editor shows before the PDF engine finishes downloading.
  const [{ pdf, Font }, { ResumePdf }] = await Promise.all([
    import("@react-pdf/renderer"),
    import("@/lib/resume/pdf"),
  ]);
  // A resume is read by parsers and people; a word split across lines as "devel-opment" helps neither.
  Font.registerHyphenationCallback((word) => [word]);
  const instance = pdf(createElement(ResumePdf, { resume: doc.resume, style: doc.style, density }));
  const blob = await instance.toBlob();
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Renders the resume at the roomiest density that fits the page budget. Pages only grow as density gets
 * tighter, so the answer is found by binary search over `DENSITIES`: about three renders, not six.
 */
export async function renderResume(doc: ResumeDoc, render = renderAt): Promise<Rendered> {
  const budget = doc.style.pages;
  let low = 0;
  let high = DENSITIES.length - 1;
  let best: Rendered | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const density = DENSITIES[mid] as Density;
    const pdf = await render(doc, density);
    const pages = pageCount(pdf);
    if (pages <= budget) {
      best = { pdf, pages, density, fits: true };
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  if (best) return best;
  const density = DENSITIES[DENSITIES.length - 1] as Density;
  const pdf = await render(doc, density);
  return { pdf, pages: pageCount(pdf), density, fits: false };
}
