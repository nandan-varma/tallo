import { parentPort } from "node:worker_threads";
import { inThreadCpu } from "@tallo/collect";

/** One pool thread: runs the same pure code as the in-thread default, one request at a time. */
const port = parentPort;
if (!port) throw new Error("cpu-worker must run in a worker thread");
port.on("message", async (msg: { id: number; method: "hashes" | "prepare"; args: unknown[] }) => {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: the pool only sends the Cpu methods' own arguments
    const value = await (inThreadCpu[msg.method] as (...a: any[]) => Promise<any>)(...msg.args);
    const transfer = msg.method === "prepare" ? [value.jd.buffer as ArrayBuffer] : [];
    port.postMessage({ id: msg.id, ok: true, value }, transfer);
  } catch (error) {
    port.postMessage({
      id: msg.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
