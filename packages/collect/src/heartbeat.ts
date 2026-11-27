/**
 * A progress line for a long run, at most once per `intervalMs`. A board of 20,000 postings fetches for hours and
 * otherwise logs only when it ends, so a stalled run (every request refused, a host blocking us) looks like a slow one.
 * Call the returned function once per finished posting; it logs when the interval has passed.
 */
export function createHeartbeat(
  log: { info(obj: object, msg?: string): void },
  fields: Record<string, unknown>,
  total: number,
  { intervalMs = 30_000, now = Date.now }: { intervalMs?: number; now?: () => number } = {},
): (done: number) => void {
  const startedAt = now();
  let lastAt = startedAt;
  let lastDone = 0;
  return (done) => {
    const at = now();
    if (at - lastAt < intervalMs) return;
    const perMinute = Math.round(((done - lastDone) * 60_000) / (at - lastAt));
    log.info(
      { ...fields, done, total, perMinute, elapsedSec: Math.round((at - startedAt) / 1000) },
      "progress",
    );
    lastAt = at;
    lastDone = done;
  };
}
