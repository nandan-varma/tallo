import { Agent } from "undici";

export interface PooledFetch {
  fetch: typeof fetch;
  close(): Promise<void>;
}

/**
 * A fetch over one shared undici agent: long keep-alive so connections are reused across boards,
 * and HTTP/2 where the host offers it (many requests over one connection). Per-host limits, retries and
 * the allowlist stay in `@tallo/http`; this only changes how bytes travel.
 */
export function createPooledFetch(connections = 32): PooledFetch {
  const dispatcher = new Agent({
    allowH2: true,
    connections,
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 120_000,
  });
  return {
    // The dispatcher is undici's extension to RequestInit; Node's own fetch honors it.
    fetch: ((input, init) => fetch(input, { ...init, dispatcher } as RequestInit)) as typeof fetch,
    close: () => dispatcher.close(),
  };
}
