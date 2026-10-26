import { gzip, sha256 } from "@tallo/catalog";
import { jdKey, memoryBlobs, schema } from "@tallo/db";
import { testDb } from "@tallo/db/testing";
import type { MockLanguageModelV4 } from "ai/test";
import { createApp } from "../src/app.ts";

export const READ = "read-token";
export const INGEST = "ingest-token";
export const auth = { authorization: `Bearer ${READ}`, "content-type": "application/json" };

export const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

export async function seedJob(
  db: ReturnType<typeof testDb>,
  blobs: ReturnType<typeof memoryBlobs>,
) {
  const text = "Pay: $200,000.";
  const jdHash = await sha256(text);
  await blobs.put(jdKey(jdHash), await gzip(new TextEncoder().encode(text)));
  await db.insert(schema.sources).values({
    id: "greenhouse:acme",
    platform: "greenhouse",
    key: "acme",
    company: "Acme",
    companySlug: "acme",
    params: {},
    lastListedAt: Math.floor(Date.now() / 1000),
  });
  await db.insert(schema.jobs).values({
    sourceId: "greenhouse:acme",
    postingId: "1",
    company: "Acme",
    companySlug: "acme",
    title: "Senior Backend Engineer",
    classifierVersion: 1,
    excerpt: text,
    jdHash,
    jdBytes: text.length,
    sourceHash: "b".repeat(64),
    facts: {},
    sortAt: 1000,
    firstSeenAt: 1,
    updatedAt: 1,
    locationText: "Remote, US",
  });
}

export function build(model: MockLanguageModelV4 | null) {
  const db = testDb();
  const blobs = memoryBlobs();
  const app = createApp({
    db,
    blobs,
    readToken: READ,
    ingestToken: INGEST,
    model: () => model,
  });
  return { app, db, blobs };
}
