import { defaultResumeDoc } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { renderResume } from "@/lib/resume/render";

/** What an applicant tracking system sees: the text layer of the PDF, in reading order. */
async function textOf(pdf: Uint8Array): Promise<string> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: pdf.slice() });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
  }
  await task.destroy();
  return pages.join("\n");
}

describe("the PDF as a parser reads it", () => {
  it("keeps contact details, sections and bullets as real text, in reading order", async () => {
    const doc = defaultResumeDoc();
    doc.resume = {
      ...doc.resume,
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: "555-0100",
      summary: "Engineer who builds reliable payment systems.",
      experience: [
        {
          company: "Acme",
          title: "Senior Engineer",
          location: "Remote",
          start: "2019",
          end: "Present",
          bullets: ["Cut p95 latency by 30% on the payments API."],
        },
      ],
      education: [
        {
          school: "MIT",
          degree: "BSc Computer Science",
          location: "",
          start: "2011",
          end: "2015",
          details: [],
        },
      ],
      skills: [{ label: "Languages", items: ["Go", "TypeScript"] }],
    };
    for (const template of ["classic", "modern"] as const) {
      doc.style.template = template;
      const text = await textOf((await renderResume(doc)).pdf);
      for (const expected of [
        "Ada Lovelace",
        "ada@example.com",
        "555-0100",
        "Senior Engineer",
        "Acme",
        "Cut p95 latency by 30% on the payments API.",
        "BSc Computer Science",
        "Go, TypeScript",
      ]) {
        expect(text, `${template}: ${expected}`).toContain(expected);
      }
      const order = ["Ada Lovelace", "EXPERIENCE", "Senior Engineer", "EDUCATION", "SKILLS"].map(
        (part) => text.indexOf(part),
      );
      expect(order, text).not.toContain(-1);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    }
  }, 60_000);
});
