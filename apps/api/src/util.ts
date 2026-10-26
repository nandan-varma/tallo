/** The error class only: messages can echo model output, which must never reach logs. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
