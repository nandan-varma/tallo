import type { HostLimiter } from "@tallo/http";

/**
 * Reserve the next `count` consecutive start slots for a host, each `gapMs` apart. Pure: given when
 * the host is next free and the current time (ms), return how long the caller must wait for the
 * first slot (slot i is at `waitMs + i * gapMs`) and when the host is free after the last one. The
 * Worker keeps `nextFreeAt` in a Durable Object per host.
 */
export function reserveSlot(
  nextFreeAt: number,
  now: number,
  gapMs: number,
  count = 1,
): { waitMs: number; nextFreeAt: number } {
  const start = Math.max(now, nextFreeAt);
  return { waitMs: start - now, nextFreeAt: start + gapMs * count };
}

/** Slots reserved per gate call by default. Unused slots delay the host by at most this many gaps. */
export const GATE_BLOCK = 8;

/**
 * A gate that reserves slots in blocks of `count` (one `reserve` call each) and hands them out
 * locally. A block is a window of starts `gapMs` apart; the next window starts after its last slot's
 * gap, so the global gap between starts is the same as with one call per request. A caller that is
 * late takes its start later but never closer than `gapMs` to the previous start; a start that
 * would leave the window is not allowed, so the window is dropped and a new block is reserved.
 * `reserve` resolves with the wait (ms) for the first slot of the block.
 */
export function batchedGate(
  reserve: (host: string, gapMs: number, count: number) => Promise<number>,
  options: {
    count?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<unknown>;
  } = {},
): (host: string, gapMs: number) => Promise<void> {
  const count = Math.max(1, options.count ?? GATE_BLOCK);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const windows = new Map<string, { prev: number; last: number }>();
  const refills = new Map<string, Promise<void>>();

  const refill = (host: string, gapMs: number): Promise<void> => {
    let pending = refills.get(host);
    if (!pending) {
      pending = reserve(host, gapMs, count)
        .then((waitMs) => {
          const first = now() + waitMs;
          windows.set(host, { prev: first - gapMs, last: first + (count - 1) * gapMs });
        })
        .finally(() => void refills.delete(host));
      refills.set(host, pending);
    }
    return pending;
  };

  return async (host, gapMs) => {
    for (let attempt = 0; ; attempt++) {
      const win = windows.get(host);
      if (win) {
        const start = Math.max(now(), win.prev + gapMs);
        if (start <= win.last) {
          win.prev = start;
          const wait = start - now();
          if (wait > 0) await sleep(wait);
          return;
        }
        windows.delete(host);
      }
      await refill(host, gapMs);
      // A block reserved a moment ago is almost always usable. If it was spent while we waited
      // (a very slow reserve), reserve again; after that, go rather than loop.
      if (attempt >= 2) return;
    }
  };
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
