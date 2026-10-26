// Splits text into consecutive parts without dropping or changing a character: parts.join("") === text.
// Each part is at most maxChars long. Cuts prefer a newline, then a space, and fall back to a hard cut.
export function chunkText(text: string, maxChars: number): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new RangeError("maxChars must be a positive integer");
  }
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("\n", maxChars - 1) + 1;
    if (cut <= 0) cut = rest.lastIndexOf(" ", maxChars - 1) + 1;
    if (cut <= 0) cut = maxChars;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}
