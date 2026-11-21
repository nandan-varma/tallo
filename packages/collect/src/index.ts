/** Collection shared by the Mac runner and the Worker: list, diff, detail, map, upload, close. */
export * from "./cpu.ts";
export * from "./engine.ts";
export * from "./gate.ts";
export * from "./messages.ts";
export * from "./policy.ts";

/** An in-memory scratch store. The runner collects in one process and needs no persistence. */
export function memoryScratch(): import("./engine.ts").Scratch {
  const map = new Map<string, Uint8Array>();
  return {
    put: async (key, bytes) => void map.set(key, bytes),
    get: async (key) => map.get(key) ?? null,
    delete: async (key) => void map.delete(key),
  };
}
