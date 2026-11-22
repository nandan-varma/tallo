import {
  llmsText,
  PUBLIC_ORIGIN,
  PUBLIC_PATHS,
  publicDescriptionSchema,
  publicDiscoverySchema,
  publicSearchSchema,
} from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { seed, setup } from "./fixtures.ts";
import { INGEST } from "./support.ts";

/** The example JSON block under a heading: what the endpoint really answers, pretty-printed. */
function exampleJson(text: string, heading: string): unknown {
  const section = text.slice(text.indexOf(heading));
  const marker =
    "Example response (illustrative values; this shape is validated by the API's own schema):";
  const at = section.indexOf(marker);
  if (at < 0) throw new Error(`no example under ${heading}`);
  const rest = section.slice(at + marker.length);
  const start = rest.indexOf("```json");
  const end = rest.indexOf("```", start + "```json".length);
  if (start < 0 || end < 0) throw new Error(`no JSON block under ${heading}`);
  return JSON.parse(rest.slice(start + "```json".length, end));
}

describe("llms.txt matches the public API", () => {
  it("documents exactly the GET routes the API serves", () => {
    const { db, blobs } = setup();
    const app = createApp({ db, blobs, ingestToken: INGEST });
    const documented = [...llmsText().matchAll(/^### GET (\S+)$/gm)].map((m) => m[1]);
    expect(documented).toEqual([...PUBLIC_PATHS]);
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
    for (const name of Object.keys(publicDiscoverySchema.shape)) {
      expect(text, name).toContain(`- ${name}: `);
      const body = (await (await app.request(`/v1/companies?${name}=x`)).json()) as {
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
    // Six endpoint examples and the two quick-start commands.
    expect(examples).toHaveLength(8);
    for (const path of examples) {
      const response = await app.request(path);
      expect(response.headers.get("content-type"), path).toContain("application/json");
      const body = (await response.json()) as { error?: { code: string } };
      // The job examples name an id this empty catalog does not hold: their own JSON 404.
      if (response.status === 200) expect(body.error, path).toBeUndefined();
      else {
        expect(response.status, path).toBe(404);
        expect(body.error?.code, path).toBe("unknown");
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
    const documentedSearch = exampleJson(text, "### GET /v1/search") as {
      results: Record<string, unknown>[];
    };
    const hitFields = Object.keys(search.results[0] ?? {}).sort();
    expect(Object.keys(documentedSearch).sort()).toEqual(
      [
        "apiVersion",
        "results",
        "count",
        "next",
        "hasMore",
        "capped",
        "expandedLocations",
        "remote",
        "asOf",
        "note",
      ].sort(),
    );
    expect(Object.keys(documentedSearch.results[0] ?? {}).sort()).toEqual(hitFields);
    expect(hitFields).toEqual(
      [
        "applyUrl",
        "company",
        "compensation",
        "countryCode",
        "department",
        "employmentType",
        "id",
        "location",
        "locations",
        "postedAt",
        "pay",
        "sourceLastListedAt",
        "title",
        "workMode",
      ].sort(),
    );

    const job = (await (await app.request(`/v1/jobs/${id}`)).json()) as Record<string, unknown>;
    const documentedJob = exampleJson(text, "### GET /v1/jobs/:id\n") as Record<string, unknown>;
    expect(Object.keys(documentedJob).sort()).toEqual(Object.keys(job).sort());
  });
});
