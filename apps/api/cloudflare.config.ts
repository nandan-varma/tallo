import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
  worker: {
    name: "tallo-api",
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/index.ts",
    observability: {
      enabled: true,
    },
    domains: ["tallo-api.nandan.fyi"],
    triggers: [
      triggers.scheduled({
        schedule: "17 * * * *",
      }),
    ],
    env: {
      DB: bindings.d1({
        name: "tallo",
        id: "001b036c-2e15-45c8-9284-edb9d374b849",
      }),
      BLOBS: bindings.r2({
        name: "tallo-blobs",
      }),
      AI_MODEL_SMART: bindings.text("go-anthropic:claude-haiku-5-5"),
    },
  },
});
