/**
 * A per-day token ledger for the assistant. The API checks it once at the start of each AI request and adds
 * each request's tokens when the request ends. Two implementations: KV (set `AI_SPEND` to a KV namespace
 * binding) and per-isolate memory (the fallback; each Worker isolate counts only what it served).
 */
export interface SpendLedger {
  /** Tokens recorded for a UTC day (`YYYY-MM-DD`). */
  used(day: string): Promise<number>;
  add(day: string, tokens: number): Promise<void>;
}

/** The part of Workers KV the ledger uses. Structural, so this package needs no Workers types. */
export interface KeyValue {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface Budget {
  ledger: SpendLedger;
  /** Tokens per UTC day. Over this, the assistant answers 429 until the day rolls over. */
  limit: number;
}

export const utcDay = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

/** Holds one day at a time: a new day replaces the old count, so memory never grows. */
export function memoryLedger(): SpendLedger {
  let current = { day: "", tokens: 0 };
  return {
    async used(day) {
      return current.day === day ? current.tokens : 0;
    },
    async add(day, tokens) {
      if (current.day !== day) current = { day, tokens: 0 };
      current.tokens += tokens;
    },
  };
}

/**
 * One KV key per day, expiring after two days. A read-modify-write is not atomic, so two requests that end at
 * the same moment can lose one update. For one user that is an acceptable error; the ceiling is a guard, not a bill.
 */
export function kvLedger(kv: KeyValue): SpendLedger {
  const key = (day: string) => `ai-spend:${day}`;
  const used = async (day: string) => Number((await kv.get(key(day))) ?? 0) || 0;
  return {
    used,
    async add(day, tokens) {
      await kv.put(key(day), String((await used(day)) + tokens), { expirationTtl: 2 * 86_400 });
    },
  };
}

/** True when the day has already reached its ceiling, so the next request must not start. */
export async function exhausted(budget: Budget, now: Date = new Date()): Promise<boolean> {
  return (await budget.ledger.used(utcDay(now))) >= budget.limit;
}
