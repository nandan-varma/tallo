import {
  llmsText,
  openApiDocument,
  PUBLIC_PATHS,
  SITE_STATS_CACHE_CONTROL,
} from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { seed, setup } from "./fixtures.ts";
import { INGEST } from "./support.ts";

describe("GET /v1/site-stats", () => {
  it("serves the snapshot with a 12 hour cache header", async () => {
    const { db, blobs } = setup();
    await seed(db, blobs, { postingId: "1", title: "Data Engineer", countryCode: "US" });
    const app = createApp({ db, blobs, ingestToken: INGEST });

    const response = await app.request("/v1/site-stats");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(SITE_STATS_CACHE_CONTROL);
    expect(await response.json()).toMatchObject({ boards: 1, sampleSize: 1 });
  });

  it("is refused on the API's own host and is not part of the public surface", async () => {
    const { db, blobs } = setup();
    const app = createApp({
      db,
      blobs,
      ingestToken: INGEST,
      readsBlockedHost: "api.example.com",
    });

    const blocked = await app.request("https://api.example.com/v1/site-stats");
    expect(blocked.status).toBe(404);
    expect((PUBLIC_PATHS as readonly string[]).includes("/v1/site-stats")).toBe(false);
    expect(llmsText()).not.toContain("site-stats");
    expect(JSON.stringify(openApiDocument())).not.toContain("site-stats");
  });
});
