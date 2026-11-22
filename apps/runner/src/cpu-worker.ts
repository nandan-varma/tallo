import { parentPort } from "node:worker_threads";
import { type Cpu, inThreadCpu } from "@tallo/collect";

/** One pool thread: runs the same pure code as the in-thread default, one request at a time. */
const port = parentPort;
if (!port) throw new Error("cpu-worker must run in a worker thread");
type Message =
  | { id: number; method: "hashes"; args: Parameters<Cpu["hashes"]> }
  | { id: number; method: "prepare"; args: Parameters<Cpu["prepare"]> };

port.on("message", async (msg: Message) => {
  try {
    if (msg.method === "hashes") {
      port.postMessage({ id: msg.id, ok: true, value: await inThreadCpu.hashes(...msg.args) });
    } else {
      const value = await inThreadCpu.prepare(...msg.args);
      port.postMessage({ id: msg.id, ok: true, value }, [value.jd.buffer as ArrayBuffer]);
    }
  } catch (error) {
    port.postMessage({
      id: msg.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
