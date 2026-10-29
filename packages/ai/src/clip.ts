/**
 * Bounds text sent to a model. Keeps the start and the end, because pay and requirements often sit at the bottom
 * of a posting, and states where the cut is, so the model never reads a gap as the whole text. Text within the
 * limit comes back unchanged.
 */
export function clip(text: string, maxChars: number): string {
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new RangeError(`maxChars must be a positive integer, got ${maxChars}`);
  }
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.4);
  const tail = maxChars - head;
  const omitted = text.length - head - tail;
  return [
    text.slice(0, head),
    `[... ${omitted} characters left out here to bound cost; the text above and below is kept ...]`,
    text.slice(text.length - tail),
  ].join("\n\n");
}
