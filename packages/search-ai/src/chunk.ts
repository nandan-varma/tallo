// Splits text into consecutive parts without dropping or changing a character: parts.join("") === text.
// Each part is at most maxChars long. Cuts prefer a newline, then a space, and fall back to a hard cut.
// A cut never separates a UTF-16 surrogate pair. That is why maxChars must be at least 2.
export function chunkText(text: string, maxChars: number): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 2) {
    throw new RangeError("maxChars must be an integer of at least 2");
  }
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("\n", maxChars - 1) + 1;
    if (cut <= 0) cut = rest.lastIndexOf(" ", maxChars - 1) + 1;
    if (cut <= 0) cut = maxChars;
    if (isHighSurrogate(rest.charCodeAt(cut - 1)) && isLowSurrogate(rest.charCodeAt(cut))) {
      cut -= 1; // cut is at least 1 here: maxChars >= 2
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
