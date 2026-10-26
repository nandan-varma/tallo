/** The letter as paragraphs: a blank line ends one. Single line breaks inside a paragraph (the sign-off) stay. */
export function paragraphs(letter: string): string[] {
  return letter
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

export const wordCount = (text: string) => {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
};
