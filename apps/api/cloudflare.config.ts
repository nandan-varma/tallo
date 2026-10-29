import { bindings, defineConfig, exports, triggers } from "cf/config";

// Keep in step with wrangler.jsonc (used for local development and `wrangler` commands).
export default defineConfig({
  worker: {
    name: "tallo-api",
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/index.ts",
    observability: {
      enabled: true,
    },
    limits: {
      cpuMs: 120000,
    },
    domains: ["tallo-api.nandan.fyi"],
    triggers: [
      triggers.scheduled({
        schedule: "17 * * * *",
      }),
      triggers.scheduled({
        schedule: "*/5 * * * *",
      }),
      triggers.queue({
        name: "tallo-collect",
        deadLetterQueue: "tallo-collect-dlq",
        maxBatchSize: 1,
        maxBatchTimeout: 0,
        maxConcurrency: 10,
        maxRetries: 2,
      }),
    ],
    exports: {
      HostGate: exports.durableObject({ storage: "sqlite" }),
    },
    env: {
      DB: bindings.d1({
        name: "tallo",
        id: "001b036c-2e15-45c8-9284-edb9d374b849",
      }),
      BLOBS: bindings.r2({
        name: "tallo-blobs",
      }),
      COLLECT: bindings.queue({
        name: "tallo-collect",
      }),
      HOST_GATE: bindings.durableObject({
        worker: "tallo-api",
        exportName: "HostGate",
      }),
      AI_MODEL_SMART: bindings.text("go-anthropic:claude-haiku-5-5"),
      COLLECT_ENABLED: bindings.text("1"),
      COLLECT_BATCH: bindings.text("100"),
      COLLECT_SLICE_SUBREQUESTS: bindings.text("800"),
      COLLECT_SLICE_MS: bindings.text("300000"),
    },
  },
});
