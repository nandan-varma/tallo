import { bindings, defineConfig, exports, triggers } from "cf/config";
import config from "./wrangler.json" with { type: "json" };

// Wrangler is the single configuration source; cf owns this Worker's deployment.
const db = config.d1_databases[0]!;
const blobs = config.r2_buckets[0]!;
const producer = config.queues.producers[0]!;
const consumer = config.queues.consumers[0]!;
const gate = config.durable_objects.bindings[0]!;

export default defineConfig({
  worker: {
    name: config.name,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    entrypoint: config.main,
    observability: config.observability,
    limits: { cpuMs: config.limits.cpu_ms },
    domains: config.routes.map((route) => route.pattern),
    triggers: [
      ...config.triggers.crons.map((schedule) => triggers.scheduled({ schedule })),
      triggers.queue({
        name: consumer.queue,
        deadLetterQueue: consumer.dead_letter_queue,
        maxBatchSize: consumer.max_batch_size,
        maxBatchTimeout: consumer.max_batch_timeout,
        maxConcurrency: consumer.max_concurrency,
        maxRetries: consumer.max_retries,
      }),
    ] as const,
    exports: { [gate.class_name]: exports.durableObject({ storage: "sqlite" }) },
    env: {
      ...Object.fromEntries(
        Object.entries(config.vars).map(([key, value]) => [key, bindings.text(value)]),
      ),
      [db.binding]: bindings.d1({ name: db.database_name, id: db.database_id }),
      [blobs.binding]: bindings.r2({ name: blobs.bucket_name }),
      [producer.binding]: bindings.queue({ name: producer.queue }),
      [gate.name]: bindings.durableObject({ worker: config.name, exportName: gate.class_name }),
    },
  },
});
