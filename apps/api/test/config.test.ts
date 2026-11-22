import { bindings, triggers } from "cf/config";
import { describe, expect, it } from "vitest";
import deployment from "../cloudflare.config.ts";
import config from "../wrangler.json" with { type: "json" };

describe("API Worker configuration", () => {
  it("derives deployment from the same configuration used locally", () => {
    expect(deployment.worker?.name).toBe(config.name);
    expect(deployment.worker?.domains).toEqual(config.routes.map((route) => route.pattern));
    for (const [key, value] of Object.entries(config.vars)) {
      expect(deployment.worker?.env?.[key]).toEqual(bindings.text(value));
    }
    for (const schedule of config.triggers.crons) {
      expect(deployment.worker?.triggers).toContainEqual(triggers.scheduled({ schedule }));
    }
  });

  it("keeps automated collection off and the API host isolated", () => {
    expect(config.vars.COLLECT_ENABLED).toBe("0");
    expect(config.vars.READS_BLOCKED_HOST).toBe("tallo-api.nandan.fyi");
    expect(config.routes.map((route) => route.pattern)).toContain(config.vars.READS_BLOCKED_HOST);
  });
});

it("derives database, bucket, queue and durable-object bindings from the canonical config", () => {
  const worker = deployment.worker!;
  const db = config.d1_databases[0]!;
  const bucket = config.r2_buckets[0]!;
  const producer = config.queues.producers[0]!;
  const consumer = config.queues.consumers[0]!;
  const gate = config.durable_objects.bindings[0]!;
  expect(worker.env?.[db.binding]).toEqual(
    bindings.d1({ name: db.database_name, id: db.database_id }),
  );
  expect(worker.env?.[bucket.binding]).toEqual(bindings.r2({ name: bucket.bucket_name }));
  expect(worker.env?.[producer.binding]).toEqual(bindings.queue({ name: producer.queue }));
  expect(worker.env?.[gate.name]).toEqual(
    bindings.durableObject({ worker: config.name, exportName: gate.class_name }),
  );
  expect(worker.triggers).toContainEqual(
    triggers.queue({
      name: consumer.queue,
      deadLetterQueue: consumer.dead_letter_queue,
      maxBatchSize: consumer.max_batch_size,
      maxBatchTimeout: consumer.max_batch_timeout,
      maxConcurrency: consumer.max_concurrency,
      maxRetries: consumer.max_retries,
    }),
  );
});
