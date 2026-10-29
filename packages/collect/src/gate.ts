import type { HostLimiter } from "@tallo/http";

/**
 * Reserve the next start slot for a host with a minimum gap between starts. Pure: given when the
 * host is next free and the current time (ms), return how long the caller must wait and when the
 * host is free after this start. The Worker keeps `nextFreeAt` in a Durable Object per host.
 */
export function reserveSlot(
  nextFreeAt: number,
  now: number,
  gapMs: number,
): { waitMs: number; nextFreeAt: number } {
  const start = Math.max(now, nextFreeAt);
  return { waitMs: start - now, nextFreeAt: start + gapMs };
}

/**
 * Wrap a per-host limiter so every request first waits for a gate slot. `gate` is called once per
 * request that has a gap (a retry of that request does not pass the gate again, as with
 * `minHostIntervalMs`). Hosts whose gap is 0 skip the gate entirely, so public boards cost no
 * extra subrequest.
 */
export function gatedLimiter(
  base: HostLimiter,
  gapFor: (host: string) => number,
  gate: (host: string, gapMs: number) => Promise<void>,
): HostLimiter {
  return {
    run<T>(host: string, task: () => Promise<T>): Promise<T> {
      return base.run(host, async () => {
        const gapMs = gapFor(host);
        if (gapMs > 0) await gate(host, gapMs);
        return task();
      });
    },
  };
}
