import { decodeHTML } from "entities";
import { convert } from "html-to-text";

const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({
  selector,
  options: { uppercase: false },
}));

/** Plain text from HTML, or from entity-escaped HTML as Greenhouse serves it. */
export function htmlToText(input: string): string {
  const escaped = !/<[a-z!/]/i.test(input) && /&lt;/i.test(input);
  return convert(escaped ? decodeHTML(input) : input, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "ul", options: { itemPrefix: "- " } },
      ...HEADINGS,
    ],
  })
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A posting title as shown: entities decoded ("R&amp;D" to "R&D", "&lt;p&gt;" to "<p>") and whitespace
 * collapsed. Nothing else changes, so short real titles such as "RN" are kept as they are.
 */
export function cleanTitle(title: string): string {
  return decodeHTML(title).replace(/\s+/g, " ").trim();
}

export function excerpt(text: string, max = 280): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}
