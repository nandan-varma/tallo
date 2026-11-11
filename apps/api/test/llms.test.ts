import {
  llmsText,
  PUBLIC_ORIGIN,
  publicDescriptionSchema,
  publicSearchSchema,
} from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { seed, setup } from "./fixtures.ts";
import { INGEST } from "./support.ts";

/** The `Response:` line under a heading, as the document names its fields. */
function responseLine(text: string, heading: string): string {
  const section = text.slice(text.indexOf(heading));
  const line = section.split("\n").find((l) => l.startsWith("Response: "));
  if (!line) throw new Error(`no Response line under ${heading}`);
  return line;
}

describe("llms.txt matches the public API", () => {
  it("documents exactly the GET routes the API serves", () => {
    const { db, blobs } = setup();
    const app = createApp({ db, blobs, ingestToken: INGEST });
    const documented = [...llmsText().matchAll(/^### GET (\S+)$/gm)].map((m) => m[1]);
    expect(documented).toEqual(["/v1/search", "/v1/jobs/:id", "/v1/jobs/:id/description"]);
    const served = new Set(app.routes.filter((r) => r.method === "GET").map((r) => r.path));
    for (const path of documented) expect(served.has(path as string), path).toBe(true);
  });

  it("names only parameters the routes accept: none is refused as unknown", async () => {
    const { db, blobs } = setup();
    const app = createApp({ db, blobs, ingestToken: INGEST });
    const text = llmsText();
    for (const name of Object.keys(publicSearchSchema.shape)) {
      expect(text, name).toContain(`- ${name}: `);
      const body = (await (await app.request(`/v1/search?title=ab&${name}=x`)).json()) as {
        error?: { code: string };
      };
      expect(body.error?.code, name).not.toBe("unknown_parameter");
    }
    for (const name of Object.keys(publicDescriptionSchema.shape)) {
      expect(text, name).toContain(`- ${name}: `);
      const body = (await (await app.request(`/v1/jobs/1/description?${name}=x`)).json()) as {
        error?: { code: string };
      };
      expect(body.error?.code, name).not.toBe("unknown_parameter");
    }
  });

  it("runs every example and gets a JSON answer from a real route", async () => {
    const { db, blobs } = setup();
    await seed(db, blobs, {
      postingId: "1",
      title: "Backend Engineer",
      location: "Remote, US",
      workMode: "remote",
    });
    const app = createApp({ db, blobs, ingestToken: INGEST });
    const examples = [...llmsText().matchAll(/"(https:\/\/tallo\.nandan\.fyi[^"]*)"/g)].map((m) =>
      String(m[1]).replace(PUBLIC_ORIGIN, ""),
    );
    expect(examples).toHaveLength(3);
    for (const path of examples) {
      const response = await app.request(path);
      expect(response.headers.get("content-type"), path).toContain("application/json");
      const body = (await response.json()) as { error?: { code: string }; results?: unknown[] };
      // The search answers 200. The job examples name an id this empty catalog does not hold: their own JSON 404.
      if (response.status === 200) {
        expect(body.results, path).toBeDefined();
      } else {
        expect(response.status, path).toBe(404);
        expect(body.error?.code, path).toBe("not_found");
      }
    }
  });

  it("describes the search hit and the job answer with the fields the API really returns", async () => {
    const { db, blobs } = setup();
    const id = await seed(db, blobs, {
      postingId: "1",
      title: "Backend Engineer",
      location: "Remote, US",
      workMode: "remote",
    });
    const app = createApp({ db, blobs, ingestToken: INGEST });
    const text = llmsText();

    const search = (await (
      await app.request("/v1/search?title=backend+engineer&location=remote")
    ).json()) as {
      results: Record<string, unknown>[];
    };
    const hitFields = Object.keys(search.results[0] ?? {});
    expect(hitFields.sort()).toEqual(
      [
        "applyUrl",
        "company",
        "department",
        "id",
        "location",
        "locations",
        "postedAt",
        "pay",
        "title",
        "workMode",
      ].sort(),
    );
    const documentedSearch = responseLine(text, "### GET /v1/search");
    for (const key of [...hitFields, "results", "next", "note"]) {
      expect(documentedSearch, key).toContain(`"${key}"`);
    }

    const job = (await (await app.request(`/v1/jobs/${id}`)).json()) as Record<string, unknown>;
    const documentedJob = responseLine(text, "### GET /v1/jobs/:id\n");
    for (const key of Object.keys(job)) expect(documentedJob, key).toContain(`"${key}"`);
  });
});
