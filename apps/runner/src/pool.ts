import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { type Cpu, inThreadCpu } from "@tallo/collect";

export interface CpuPool extends Cpu {
  readonly size: number;
  close(): Promise<void>;
}

/** Threads to use unless told otherwise: leave one core for the event loop, cap at 4. */
export const defaultThreads = () => Math.max(1, Math.min(4, availableParallelism() - 1));

interface Slot {
  worker: Worker;
  busy: number;
  alive: boolean;
}

interface Reply {
  id: number;
  ok: boolean;
  value?: never;
  error?: string;
}

/**
 * A fixed pool of worker threads for the CPU-heavy steps (hash, map, prepare, gzip). Each request goes
 * to the least busy thread. A thread that dies rejects its requests; with no thread left the pool runs
 * in this thread, so a broken pool slows the run down but never changes its result.
 */
export function createCpuPool(size: number): CpuPool {
  let nextId = 0;
  const pending = new Map<
    number,
    { slot: Slot; resolve: (v: never) => void; reject: (e: Error) => void }
  >();
  const slots: Slot[] = Array.from({ length: size }, () => {
    const slot: Slot = {
      worker: new Worker(new URL("./cpu-worker.ts", import.meta.url)),
      busy: 0,
      alive: true,
    };
    slot.worker.unref();
    slot.worker.on("message", (msg: Reply) => {
      const job = pending.get(msg.id);
      if (!job) return;
      pending.delete(msg.id);
      slot.busy--;
      if (msg.ok) job.resolve(msg.value as never);
      else job.reject(new Error(msg.error));
    });
    const die = (error: Error) => {
      slot.alive = false;
      for (const [id, job] of pending)
        if (job.slot === slot) {
          pending.delete(id);
          job.reject(error);
        }
    };
    slot.worker.on("error", die);
    slot.worker.on("exit", () => die(new Error("cpu worker exited")));
    return slot;
  });

  function call<T>(method: "hashes" | "prepare", args: unknown[]): Promise<T> {
    let slot: Slot | undefined;
    for (const s of slots) if (s.alive && (!slot || s.busy < slot.busy)) slot = s;
    if (!slot) return (inThreadCpu[method] as (...a: unknown[]) => Promise<T>)(...args);
    const target = slot;
    const id = nextId++;
    target.busy++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { slot: target, resolve: resolve as (v: never) => void, reject });
      target.worker.postMessage({ id, method, args });
    });
  }

  return {
    size,
    hashes: (source, listings) => call("hashes", [source, listings]),
    prepare: (source, posting, hash) => call("prepare", [source, posting, hash]),
    async close() {
      await Promise.all(slots.map((s) => s.worker.terminate()));
    },
  };
}
