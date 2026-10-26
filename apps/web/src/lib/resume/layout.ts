/** How tightly the resume is set. All spacing in the PDF derives from these three numbers and the margin. */
export interface Density {
  /** Body size in points. */
  font: number;
  /** Line height as a multiple of the size. */
  line: number;
  /** Page margin in points. */
  margin: number;
  /** Base vertical gap between blocks in points. */
  gap: number;
}

/** Roomiest first. The renderer takes the first one that fits the page budget. */
export const DENSITIES: readonly Density[] = [
  { font: 10.5, line: 1.38, margin: 50, gap: 11 },
  { font: 10.25, line: 1.34, margin: 46, gap: 10 },
  { font: 10, line: 1.3, margin: 42, gap: 9 },
  { font: 9.5, line: 1.26, margin: 38, gap: 8 },
  { font: 9, line: 1.22, margin: 34, gap: 7 },
  { font: 8.5, line: 1.18, margin: 30, gap: 6 },
];

/** Beyond WinAnsi (what the PDF standard fonts cover) there is nothing to draw, so say it plainly instead. */
const REPLACEMENTS: Record<string, string> = {
  "→": "->",
  "←": "<-",
  "⇒": "=>",
  "≥": ">=",
  "≤": "<=",
  "≈": "~",
  "×": "x",
  "−": "-",
  "‐": "-",
  "‑": "-",
  " ": " ",
  " ": " ",
  " ": " ",
  "★": "*",
  "✓": "",
  ł: "l",
  Ł: "L",
  đ: "d",
  Đ: "D",
  ı: "i",
};
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
const COMBINING = /\p{M}/gu;

/** Text the standard PDF fonts can draw: Latin-1 plus the WinAnsi extras. Anything else is mapped or dropped. */
export function safeText(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (
      code === 9 ||
      code === 10 ||
      (code >= 32 && code <= 126) ||
      (code >= 160 && code <= 255) ||
      WIN_ANSI_EXTRA.has(char)
    ) {
      out += char === " " ? " " : char;
      continue;
    }
    const mapped = REPLACEMENTS[char];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    // "ł" -> "l", "ő" -> "o": strip the mark and keep the base letter when that is drawable.
    const base = char.normalize("NFD").replace(COMBINING, "");
    out += base.length > 0 && [...base].every((c) => (c.codePointAt(0) ?? 0) <= 255) ? base : "";
  }
  return out;
}

const PAGES = /\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/;

/** Page count of a PDF written by pdfkit, whose page tree dictionary is stored uncompressed. */
export function pageCount(pdf: Uint8Array): number {
  const head = new TextDecoder("latin1").decode(pdf);
  const match = head.match(PAGES) ?? head.match(/\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/);
  return match ? Number(match[1]) : 1;
}
