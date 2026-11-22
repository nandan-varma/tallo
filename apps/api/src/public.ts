import { gunzip } from "@tallo/catalog";
import {
  decodeCursor,
  descriptionChunk,
  encodeCursor,
  JOB_CACHE_CONTROL,
  NEGATIVE_CACHE_CONTROL,
  openApiDocument,
  POSTING_ID_SOURCE,
  PUBLIC_API_VERSION,
  PUBLIC_COST_HEADER,
  PUBLIC_MAX_URL_CHARS,
  type PublicCompanyList,
  type PublicDescriptionResponse,
  type PublicError,
  type PublicJob,
  type PublicSearchPage,
  type PublicTitleList,
  publicDescriptionSchema,
  publicDiscoverySchema,
  publicError,
  publicSearchSchema,
  SEARCH_CACHE_CONTROL,
  SITE_STATS_CACHE_CONTROL,
  searchNote,
} from "@tallo/contracts";
import {
  type BlobStore,
  type Db,
  type JobState,
  jdKey,
  jobState,
  listCompanies,
  listTitleTokens,
  listVariants,
  readSiteStats,
} from "@tallo/db";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { z } from "zod";
import { measure } from "./meter.ts";
import { locationOf, postedOf, searchPage, seenAt } from "./search.ts";

/** Reads a posting's description from its gzipped blob in R2; null when the blob is gone. */
const descriptionReader = (blobs: BlobStore) => async (jdHash: string) => {
  const blob = await blobs.get(jdKey(jdHash));
  return blob ? new TextDecoder().decode(await gunzip(blob)) : null;
};

/** Names of the query parameters that repeat in the URL. Every other parameter takes one value. */
const REPEATED = new Set(["title", "company", "location", "country"]);

/** What to type instead, per parameter: shown to the caller when that parameter is wrong. */
const SEARCH_HINTS: Record<string, string> = {
  title:
    "Repeat title once per job title, 1 to 8 values of 2 to 80 characters: /v1/search?title=backend+engineer&title=platform+engineer",
  company:
    "Repeat company up to 4 times, 2 to 80 characters each: /v1/search?title=backend+engineer&company=Stripe",
  location:
    "Repeat location up to 8 times, 2 to 60 characters each, in the person's own words: /v1/search?title=backend+engineer&location=NYC&location=remote",
  country:
    "Repeat country up to 8 times with two-letter ISO 3166-1 alpha-2 codes: /v1/search?title=backend+engineer&country=US&country=CA",
  postedWithin:
    "A whole number of days from 1 to 365: /v1/search?title=backend+engineer&postedWithin=30",
  limit: "A whole number from 1 to 25 (default 10): /v1/search?title=backend+engineer&limit=25",
  sort: "One of relevance (default), recent, posted or added: /v1/search?title=backend+engineer&sort=recent",
  cursor:
    "Pass the next value from the previous response, unchanged, with the same title, company, location, country, postedWithin and sort.",
};

const DESCRIPTION_HINTS: Record<string, string> = {
  offset:
    "A whole number from 0 up to descriptionChars, the description's length: /v1/jobs/123/description?offset=4000",
  limit:
    "Optional. A whole number of 1 or more; leave it out to get the rest of the description: /v1/jobs/123/description?offset=4000&limit=2000",
};

const DISCOVERY_HINTS: Record<string, string> = {
  prefix: "A short start of a name, 1 to 40 characters: /v1/companies?prefix=goog",
  limit: "A whole number from 1 to 50: /v1/companies?prefix=goog&limit=10",
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
function fail(c: Context, status: 400 | 404 | 410 | 414, body: PublicError) {
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

/**
 * Refuses the public reads on one host. The API's own custom domain also serves them (the runner ingests through it),
 * where the web's limit and cache do not apply; the web reaches the API through its service binding on a neutral host.
 */
const hiddenOn =
  (blockedHost: string | undefined): MiddlewareHandler =>
  async (c, next) => {
    if (blockedHost && new URL(c.req.url).hostname === blockedHost) {
      return fail(
        c,
        404,
        publicError(
          "not_found",
          "No such route on this host.",
          "The public API is served at https://tallo.nandan.fyi/v1/. Read /llms.txt there.",
        ),
      );
    }
    await next();
  };

/** A positive whole id from the path, or null. */
const POSTING_ID = new RegExp(`^${POSTING_ID_SOURCE}$`);
const jobId = (raw: string): number | null => (POSTING_ID.test(raw) ? Number(raw) : null);

const badId = () =>
  publicError(
    "invalid_parameter",
    "id: must be a positive whole number.",
    "Use the id of a search result, for example /v1/jobs/123.",
  );

const closed = (id: number) =>
  publicError(
    "closed",
    `Posting ${id} is closed.`,
    "Search again for current postings: /v1/search?title=backend+engineer. Do not retry this id.",
  );

const sourceHidden = (id: number) =>
  publicError(
    "source_hidden",
    `Posting ${id} is not shown because its source stopped listing.`,
    "The catalog hides postings from boards that have not listed for a while. Search again for current postings.",
  );

const unknown = (id: number) =>
  publicError(
    "unknown",
    `No posting has id ${id}.`,
    "Use an id from a search result (/v1/search?title=backend+engineer). Ids are opaque strings; pass one back unchanged.",
  );

/**
 * The answer for a posting that cannot be read. These states are stable, so they are cacheable for the state's own TTL
 * (`NEGATIVE_CACHE_CONTROL`): a repeat ask for a closed or unknown id should not cost the database each time.
 */
function notReadable(c: Context, id: number, state: Exclude<JobState, { kind: "ok" }>) {
  if (state.kind === "closed") {
    c.header("cache-control", NEGATIVE_CACHE_CONTROL.closed);
    return c.json(closed(id), 410);
  }
  if (state.kind === "source_hidden") {
    c.header("cache-control", NEGATIVE_CACHE_CONTROL.source_hidden);
    return c.json(sourceHidden(id), 404);
  }
  c.header("cache-control", NEGATIVE_CACHE_CONTROL.unknown);
  return c.json(unknown(id), 404);
}

const PUBLIC_PATHS = [
  "/v1/openapi.json",
  "/v1/search",
  "/v1/jobs/:id",
  "/v1/jobs/:id/description",
  "/v1/companies",
  "/v1/titles",
  "/v1/site-stats",
];

/**
 * The public read routes: search, one posting, its description, and discovery. No auth. Only these paths are served
 * to the public; the web Worker forwards exactly these (see `apps/web/src/lib/public.ts`).
 */
export function publicRoutes({
  db,
  blobs,
  blockedHost,
}: {
  db: Db;
  blobs: BlobStore;
  /** The host the reads are refused on (`READS_BLOCKED_HOST`): the API's public custom domain. Unset: allowed. */
  blockedHost?: string;
}) {
  const routes = new Hono();
  const descriptionOf = descriptionReader(blobs);
  const hidden = hiddenOn(blockedHost);

  // Public, credential-free, GET only: `*` is the honest origin policy. Preflight is answered here too. Both layers are
  // registered per public path: a wildcard would also wrap the token-guarded ingest and admin routes.
  // Every public read is measured: what the database did for it leaves in one header, which the public proxy logs and
  // strips before anything is cached or returned.
  for (const path of PUBLIC_PATHS) {
    routes.use(path, async (c, next) => {
      c.header("access-control-allow-origin", "*");
      c.header("access-control-allow-methods", "GET, OPTIONS");
      c.header("access-control-allow-headers", "content-type");
      await next();
    });
    routes.options(path, (c) => c.body(null, 204));
    routes.use(path, async (c, next) => {
      const cost = await measure(next);
      c.res.headers.set(PUBLIC_COST_HEADER, JSON.stringify(cost));
    });
  }

  routes.get("/v1/openapi.json", hidden, (c) => {
    c.header("cache-control", "public, max-age=3600, s-maxage=3600");
    return c.json(openApiDocument());
  });

  routes.get("/v1/search", hidden, async (c) => {
    const url = new URL(c.req.url);
    if (tooLong(url)) return fail(c, 414, longUrl());
    const parsed = readQuery(url, publicSearchSchema, SEARCH_HINTS);
    if (!parsed.ok) return fail(c, 400, parsed.body);

    const { title, company, location, country, postedWithin, sort, limit, cursor } = parsed.value;
    if (title.length === 0 && company.length === 0) {
      return fail(
        c,
        400,
        publicError(
          "invalid_parameter",
          "title: give at least one title or company value.",
          "Repeat title (1 to 8 values) or company (up to 4): /v1/search?title=backend+engineer or /v1/search?company=Stripe",
        ),
      );
    }
    const query = { title, company, location, country, postedWithin, sort };
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
            "Pass the next value from the last response, unchanged, with the same title, company, location, country, postedWithin and sort. Omit cursor to start over.",
          ),
        );
      }
      offset = decoded;
    }

    const page = await searchPage(db, {
      queries: title,
      companies: company,
      locations: location,
      countries: country,
      postedWithin,
      sort,
      offset,
      limit,
    });
    const next = page.nextOffset === null ? null : encodeCursor(query, page.nextOffset);
    const body: PublicSearchPage = {
      apiVersion: PUBLIC_API_VERSION,
      results: page.hits,
      count: page.count,
      next,
      hasMore: page.hasMore,
      capped: page.capped,
      expandedLocations: page.expanded.locations,
      remote: page.expanded.remote,
      asOf: page.asOf,
      note: searchNote({
        count: page.count,
        hasMore: page.hasMore,
        capped: page.capped,
        offset,
        sort,
      }),
    };
    c.header("cache-control", SEARCH_CACHE_CONTROL);
    return c.json(body);
  });

  routes.get("/v1/jobs/:id", hidden, async (c) => {
    const url = new URL(c.req.url);
    if (tooLong(url)) return fail(c, 414, longUrl());
    const id = jobId(c.req.param("id"));
    if (id === null) return fail(c, 400, badId());
    const state = await jobState(db, id);
    if (state.kind !== "ok") return notReadable(c, id, state);
    const job = state.job;

    const text = await descriptionOf(job.jdHash);
    const chunk = text === null ? null : descriptionChunk(text, 0);
    const variants = await listVariants(db, job);
    const body: PublicJob = {
      apiVersion: PUBLIC_API_VERSION,
      id: String(job.id),
      title: job.title,
      company: job.company,
      location: locationOf(job),
      workMode: job.workMode as PublicJob["workMode"],
      pay: job.pay,
      compensation: Array.isArray(job.facts.compensation)
        ? (job.facts.compensation as PublicJob["compensation"])
        : [],
      postedAt: postedOf(job.postedAt),
      department: job.department,
      employmentType: job.employmentType,
      countryCode: job.countryCode,
      applyUrl: job.applyUrl ?? job.url,
      sourceLastListedAt: seenAt(job.sourceLastListedAt),
      /** Every open location of this posting, this one included. */
      variants: variants.map((v) => ({
        id: String(v.id),
        location: locationOf(v),
        workMode: v.workMode as PublicJob["workMode"],
        postedAt: postedOf(v.postedAt),
        applyUrl: v.applyUrl ?? v.url,
      })),
      descriptionChars: text === null ? null : text.length,
      description: chunk?.text ?? null,
      descriptionNext: chunk?.next ?? null,
    };
    c.header("cache-control", JOB_CACHE_CONTROL);
    return c.json(body);
  });

  routes.get("/v1/jobs/:id/description", hidden, async (c) => {
    const url = new URL(c.req.url);
    if (tooLong(url)) return fail(c, 414, longUrl());
    const id = jobId(c.req.param("id"));
    if (id === null) return fail(c, 400, badId());
    const parsed = readQuery(url, publicDescriptionSchema, DESCRIPTION_HINTS);
    if (!parsed.ok) return fail(c, 400, parsed.body);

    const state = await jobState(db, id);
    if (state.kind !== "ok") return notReadable(c, id, state);
    const job = state.job;
    const text = await descriptionOf(job.jdHash);
    if (text === null) {
      return fail(
        c,
        404,
        publicError(
          "description_missing",
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
    const body: PublicDescriptionResponse = {
      apiVersion: PUBLIC_API_VERSION,
      id: String(job.id),
      offset,
      descriptionChars: text.length,
      description: chunk.text,
      descriptionNext: chunk.next,
    };
    return c.json(body);
  });

  routes.get("/v1/companies", hidden, async (c) => {
    const url = new URL(c.req.url);
    if (tooLong(url)) return fail(c, 414, longUrl());
    const parsed = readQuery(url, publicDiscoverySchema, DISCOVERY_HINTS);
    if (!parsed.ok) return fail(c, 400, parsed.body);
    const { prefix, limit } = parsed.value;
    const page = await listCompanies(db, { prefix, limit });
    const body: PublicCompanyList = {
      apiVersion: PUBLIC_API_VERSION,
      asOf: new Date().toISOString(),
      count: page.companies.length,
      companies: page.companies,
      truncated: page.truncated,
    };
    c.header("cache-control", JOB_CACHE_CONTROL);
    return c.json(body);
  });

  routes.get("/v1/titles", hidden, async (c) => {
    const url = new URL(c.req.url);
    if (tooLong(url)) return fail(c, 414, longUrl());
    const parsed = readQuery(url, publicDiscoverySchema, DISCOVERY_HINTS);
    if (!parsed.ok) return fail(c, 400, parsed.body);
    const { prefix, limit } = parsed.value;
    const page = await listTitleTokens(db, { prefix, limit });
    const body: PublicTitleList = {
      apiVersion: PUBLIC_API_VERSION,
      asOf: new Date().toISOString(),
      count: page.titles.length,
      titles: page.titles,
      truncated: page.truncated,
    };
    c.header("cache-control", JOB_CACHE_CONTROL);
    return c.json(body);
  });

  // Internal: the /status page's snapshot, read by the web Worker over its service binding. Not in PUBLIC_PATHS,
  // llms.txt or the OpenAPI document. The hourly cron stores it (refreshSiteStats); this is a one-row read.
  routes.get("/v1/site-stats", hidden, async (c) => {
    const stats = await readSiteStats(db);
    if (!stats) return c.json({ error: "not_ready" }, 503);
    c.header("cache-control", SITE_STATS_CACHE_CONTROL);
    return c.json(stats);
  });

  return routes;
}
