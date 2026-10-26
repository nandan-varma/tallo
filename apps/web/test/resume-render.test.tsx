import { defaultResumeDoc, type ResumeDoc } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { DENSITIES, pageCount, safeText } from "@/lib/resume/layout";
import { renderResume } from "@/lib/resume/render";

const docWith = (bullets: number, pages = 1): ResumeDoc => {
  const doc = defaultResumeDoc();
  doc.style.pages = pages;
  doc.resume.name = "Ada Lovelace";
  doc.resume.email = "ada@example.com";
  doc.resume.experience = Array.from({ length: 4 }, (_, i) => ({
    company: `Company ${i}`,
    title: "Engineer",
    location: "Remote",
    start: "2020",
    end: "2022",
    bullets: Array.from(
      { length: bullets },
      (_, b) =>
        `Delivered result number ${b} of project ${i} by improving the system design and throughput.`,
    ),
  }));
  return doc;
};

describe("safeText", () => {
  it("keeps what the standard fonts draw and maps or drops the rest", () => {
    expect(safeText("José – “quoted” • 5 → 6 ≥ 3 ł ✓ 日本")).toBe(
      "José – “quoted” • 5 -> 6 >= 3 l  ",
    );
  });
});

describe("renderResume", () => {
  it("renders real PDF bytes and counts pages", async () => {
    const out = await renderResume(docWith(2));
    expect(new TextDecoder().decode(out.pdf.slice(0, 5))).toBe("%PDF-");
    expect(out.pages).toBe(1);
    expect(out.fits).toBe(true);
    expect(pageCount(out.pdf)).toBe(1);
  });

  it("uses a tighter density for a longer resume, and says when nothing fits", async () => {
    const short = await renderResume(docWith(1));
    const long = await renderResume(docWith(10));
    expect(DENSITIES.indexOf(long.density)).toBeGreaterThan(DENSITIES.indexOf(short.density));
    expect(long.fits).toBe(true);

    const huge = await renderResume(docWith(30));
    expect(huge.fits).toBe(false);
    expect(huge.pages).toBeGreaterThan(1);
    expect(huge.density).toBe(DENSITIES.at(-1));

    const roomy = await renderResume(docWith(18, 2));
    expect(roomy.pages).toBeLessThanOrEqual(2);
    expect(roomy.fits).toBe(true);
  }, 60_000);
});
