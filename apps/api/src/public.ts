import { gunzip } from "@tallo/catalog";
import {
  DESCRIPTION_CHUNK,
  decodeCursor,
  descriptionChunk,
  encodeCursor,
  JOB_CACHE_CONTROL,
  POSTING_ID_SOURCE,
  PUBLIC_MAX_URL_CHARS,
  type PublicError,
  type PublicSearchPage,
  publicDescriptionSchema,
  publicError,
  publicSearchSchema,
  SEARCH_CACHE_CONTROL,
  searchNote,
} from "@tallo/contracts";
import { type BlobStore, type Db, jdKey, listVariants, openJob } from "@tallo/db";
import type { Context } from "hono";
import { Hono } from "hono";
import type { z } from "zod";
import { locationOf, postedOf, searchPage } from "./search.ts";

/** Reads a posting's description from its gzipped blob in R2; null when the blob is gone. */
export const descriptionReader = (blobs: BlobStore) => async (jdHash: string) => {
  const blob = await blobs.get(jdKey(jdHash));
  return blob ? new TextDecoder().decode(await gunzip(blob)) : null;
};

/** Names of the query parameters that repeat in the URL. Every other parameter takes one value. */
const REPEATED = new Set(["title", "company", "location"]);

/** What to type instead, per parameter: shown to the caller when that parameter is wrong. */
const SEARCH_HINTS: Record<string, string> = {
  title:
    "Repeat title once per job title, 1 to 8 values of 2 to 80 characters: /v1/search?title=backend+engineer&title=platform+engineer",
  company:
    "Repeat company up to 4 times, 2 to 80 characters each: /v1/search?title=backend+engineer&company=Stripe",
  location:
    "Repeat location up to 8 times, 2 to 60 characters each, in the person's own words: /v1/search?title=backend+engineer&location=NYC&location=remote",
  limit: "A whole number from 1 to 25 (default 10): /v1/search?title=backend+engineer&limit=25",
  cursor:
    "Pass the next value from the previous response, unchanged, with the same title, company and location.",
};

const DESCRIPTION_HINTS: Record<string, string> = {
  offset:
    "A whole number from 0 up to descriptionChars, the description's length: /v1/jobs/123/description?offset=4000",
  limit:
    "A whole number from 1 to 8000 (default 4000): /v1/jobs/123/description?offset=4000&limit=8000",
};

type Parsed<S extends z.ZodObject> =
  | { ok: true; value: z.output<S> }
  | { ok: false; body: PublicError };

/**
 * The query string as a schema's input: unknown parameters are refused (a typo must not be silently ignored), and each
 * failure names the parameter, says what it takes, and gives an example.
 */
function readQuery<S extends z.ZodObject>(
  url: URL,
  schema: S,
  hints: Record<string, string>,
): Parsed<S> {
  const names = Object.keys(schema.shape);
  for (const key of new Set(url.searchParams.keys())) {
    if (!names.includes(key)) {
      return {
        ok: false,
        body: publicError(
          "unknown_parameter",
          `"${key}" is not a parameter of this endpoint.`,
          `Allowed parameters: ${names.join(", ")}.`,
        ),
      };
    }
  }
  const input = Object.fromEntries(
    names.map((name) => [
      name,
      REPEATED.has(name)
        ? url.searchParams.getAll(name)
        : (url.searchParams.get(name) ?? undefined),
    ]),
  );
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  const issue = result.error.issues[0];
  const name = String(issue?.path[0] ?? "");
  return {
    ok: false,
    body: publicError(
      "invalid_parameter",
      `${name}: ${issue?.message ?? "is invalid"}.`,
      hints[name] ?? "See the parameter list in /llms.txt.",
    ),
  };
}

/** Errors are never cached: a corrected request must not be answered from an old mistake. */
function fail(c: Context, status: 400 | 404 | 414, body: PublicError) {
  c.header("cache-control", "no-store");
  return c.json(body, status);
}

const tooLong = (url: URL) => url.pathname.length + url.search.length > PUBLIC_MAX_URL_CHARS;

const longUrl = () =>
  publicError(
    "uri_too_long",
    `The path and query are longer than ${PUBLIC_MAX_URL_CHARS} characters.`,
    "Use fewer or shorter title, company and location values.",
  );

/** A positive whole id from the path, or null. */
const POSTING_ID = new RegExp(`^${POSTING_ID_SOURCE}$`);
const jobId = (raw: string): number | null => (POSTING_ID.test(raw) ? Number(raw) : null);

const badId = () =>
  publicError(
    "invalid_parameter",
    "id: must be a positive whole number.",
    "Use the id of a search result, for example /v1/jobs/123.",
  );

const notFound = (id: number) =>
  publicError(
    "not_found",
    `No open posting has id ${id}.`,
    "The posting may have closed, or its source may have stopped listing. Search again for current postings: /v1/search?title=backend+engineer",
  );

/**
 * The public read routes: search, one posting, and its description in chunks. No auth. Only these three paths are
 * served to the public; the web Worker forwards exactly these (see `apps/web/src/lib/public.ts`).
 */
export function publicRoutes({ db, blobs }: { db: Db; blobs: BlobStore }) {
  const routes = new Hono();
  const descriptionOf = descriptionReader(blobs);

  routes.get("/v1/search", async (c) => {
    const url = new URL(c.req.url);
    if (tooLong(url)) return fail(c, 414, longUrl());
    const parsed = readQuery(url, publicSearchSchema, SEARCH_HINTS);
    if (!parsed.ok) return fail(c, 400, parsed.body);

    const { title, company, location, limit, cursor } = parsed.value;
    const query = { title, company, location };
    let offset = 0;
    if (cursor !== undefined) {
      const decoded = decodeCursor(cursor, query);
      if (decoded === null) {
        return fail(
          c,
          400,
          publicError(
            "invalid_cursor",
            "cursor: this is not a cursor for this search.",
            "Pass the next value from the last response, unchanged, with the same title, company and location. Omit cursor to start over.",
          ),
        );
      }
      offset = decoded;
    }

    const page = await searchPage(db, {
      queries: title,
      companies: company,
      locations: location,
      offset,
      limit,
    });
    const next = page.nextOffset === null ? null : encodeCursor(query, page.nextOffset);
    const body: PublicSearchPage = {
      results: page.hits,
      next,
      note: searchNote(page.hits.length, next !== null),
    };
    c.header("cache-control", SEARCH_CACHE_CONTROL);
    return c.json(body);
  });

  routes.get("/v1/jobs/:id", async (c) => {
    const url = new URL(c.req.url);
    if (tooLong(url)) return fail(c, 414, longUrl());
    const id = jobId(c.req.param("id"));
    if (id === null) return fail(c, 400, badId());
    const job = await openJob(db, id);
    if (!job) return fail(c, 404, notFound(id));

    const text = await descriptionOf(job.jdHash);
    const chunk = text === null ? null : descriptionChunk(text, 0, DESCRIPTION_CHUNK);
    const variants = await listVariants(db, job);
    c.header("cache-control", JOB_CACHE_CONTROL);
    return c.json({
      id: String(job.id),
      title: job.title,
      company: job.company,
      location: locationOf(job),
      workMode: job.workMode,
      pay: job.pay,
      postedAt: postedOf(job.postedAt),
      department: job.department,
      employmentType: job.employmentType,
      applyUrl: job.applyUrl ?? job.url,
      /** Every open location of this posting, this one included. */
      variants: variants.map((v) => ({
        id: String(v.id),
        location: locationOf(v),
        workMode: v.workMode,
        postedAt: postedOf(v.postedAt),
        applyUrl: v.applyUrl ?? v.url,
      })),
      descriptionChars: text === null ? null : text.length,
      description: chunk?.text ?? null,
      descriptionNext: chunk?.next ?? null,
    });
  });

  routes.get("/v1/jobs/:id/description", async (c) => {
    const url = new URL(c.req.url);
    if (tooLong(url)) return fail(c, 414, longUrl());
    const id = jobId(c.req.param("id"));
    if (id === null) return fail(c, 400, badId());
    const parsed = readQuery(url, publicDescriptionSchema, DESCRIPTION_HINTS);
    if (!parsed.ok) return fail(c, 400, parsed.body);

    const job = await openJob(db, id);
    if (!job) return fail(c, 404, notFound(id));
    const text = await descriptionOf(job.jdHash);
    if (text === null) {
      return fail(
        c,
        404,
        publicError(
          "not_found",
          `Posting ${id} has no stored description.`,
          `Use the job page for its facts and apply link: /v1/jobs/${id}`,
        ),
      );
    }
    const { offset, limit } = parsed.value;
    if (offset > text.length) {
      return fail(
        c,
        400,
        publicError(
          "invalid_parameter",
          `offset: is past the end of the description (${text.length} characters).`,
          "Use descriptionNext from the last chunk, or an offset up to descriptionChars.",
        ),
      );
    }
    const chunk = descriptionChunk(text, offset, limit);
    c.header("cache-control", JOB_CACHE_CONTROL);
    return c.json({
      id: String(job.id),
      offset,
      descriptionChars: text.length,
      description: chunk.text,
      descriptionNext: chunk.next,
    });
  });

  return routes;
}
