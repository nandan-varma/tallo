import { and, eq, or, type SQL, sql } from "drizzle-orm";
import { rankedSpec } from "../../../apps/api/src/search.ts";
import type { Db } from "../src/db.ts";
import { ftsScope, groupKey, rankedJobs, schema, visibleJobs } from "../src/index.ts";

const { jobs } = schema;

import type { EvalCase, MustNot } from "./cases.ts";

/** Hits asked for in one request: the whole result list the site shows. */
export const EVAL_LIMIT = 300;
/** Precision is measured on the first page the person sees. */
export const PRECISION_AT = 20;
/** Recall is measured against what a full list can hold: at most this many postings. */
export const RECALL_CAP = EVAL_LIMIT;

/** Cumulative D1 rows read, when the database reports it (production only). */
export interface Meter {
  rowsRead: number;
}

/** A ranked result as the harness needs it. */
interface Row {
  title: string;
  company: string;
  locationText: string | null;
  workMode: string | null;
}

/**
 * Plural and singular alike: the match is on words, and the plural of a word is the same word for this purpose.
 * (The full-text index stems, so the truth counts agree; this crude rule is only for the in-memory checks.)
 */
const words = (text: string): string[] =>
  (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((w) =>
    w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w,
  );

/** Every word of the phrase appears somewhere in the text. */
function hasAllWords(text: string, phrase: string): boolean {
  const have = new Set(words(text));
  return words(phrase).every((w) => have.has(w));
}

const anyPhrase = (text: string, phrases: string[]) => phrases.some((p) => hasAllWords(text, p));

/** Whether a row is one the request should return. */
export function isRelevant(row: Row, c: EvalCase): boolean {
  const { must } = c;
  const titleOk = anyPhrase(row.title, must.title);
  const remoteOk = must.remote === true && row.workMode === "remote";
  const placeOk = must.place ? anyPhrase(row.locationText ?? "", must.place) : false;
  const needsPlace = must.remote === true || must.place !== undefined;
  const companyOk = must.company ? anyPhrase(row.company, must.company) : true;
  return (
    titleOk &&
    (!needsPlace || remoteOk || placeOk) &&
    companyOk &&
    !wrongTitle(row.title, c.mustNot)
  );
}

function wrongTitle(title: string, mustNot: MustNot | undefined): boolean {
  if (!mustNot?.title) return false;
  const have = new Set(words(title));
  return mustNot.title.some((w) => words(w).some((x) => have.has(x)));
}

/**
 * How many distinct postings (grouped as the search groups them) the truth asks for, counted in SQL over the same
 * index and visibility the site uses, but with no candidate cut. Capped at RECALL_CAP + 1: that is all recall needs.
 */
export async function truthCount(db: Db, c: EvalCase, now: number): Promise<number> {
  const conditions: SQL[] = [
    ...visibleJobs(now),
    sql`${jobs.id} IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ${ftsScope("title", c.must.title)})`,
  ];
  const places: SQL[] = [];
  if (c.must.remote) places.push(eq(jobs.workMode, "remote"));
  if (c.must.place) {
    places.push(
      sql`${jobs.id} IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ${ftsScope("location_text", c.must.place)})`,
    );
  }
  if (places.length > 0) conditions.push(or(...places) as SQL);
  if (c.must.company) {
    conditions.push(
      sql`${jobs.id} IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ${ftsScope("company", c.must.company)})`,
    );
  }
  const wrong = ftsScope("title", c.mustNot?.title ?? []);
  if (wrong) {
    conditions.push(
      sql`${jobs.id} NOT IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ${wrong})`,
    );
  }
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(
      sql`(SELECT DISTINCT ${groupKey} AS grp FROM ${jobs} WHERE ${and(...conditions)} LIMIT ${RECALL_CAP + 1}) AS truth`,
    );
  return Number(row?.n ?? 0);
}

export interface CaseResult {
  id: string;
  /** Share of the first PRECISION_AT rows that are relevant. Null when nothing was returned (nothing to judge). */
  precision: number | null;
  /** Null when the truth is empty (nothing to recall). */
  recall: number | null;
  returned: number;
  relevant: number;
  truth: number;
  /** Null when the database does not report it (the in-memory fixture). */
  rowsRead: number | null;
  ms: number;
}

export interface Report {
  mode: string;
  at: string;
  cases: CaseResult[];
  total: {
    cases: number;
    /** Mean over the cases that returned rows. */
    precision: number;
    recall: number;
    rowsRead: number | null;
    ms: number;
  };
}

/** A pre-computed truth, keyed by case id, so before and after runs compare against the same snapshot. */
export type TruthCache = Record<string, number>;

export async function runCase(
  db: Db,
  c: EvalCase,
  now: number,
  meter: Meter | null,
  truths: TruthCache,
): Promise<CaseResult> {
  const readBefore = meter?.rowsRead ?? 0;
  const started = performance.now();
  const rows = await rankedJobs(db, rankedSpec(c.spec), { limit: EVAL_LIMIT, offset: 0 }, now);
  const ms = performance.now() - started;
  const rowsRead = meter ? meter.rowsRead - readBefore : null;

  const head = rows.slice(0, PRECISION_AT);
  const precision =
    head.length === 0 ? null : head.filter((r) => isRelevant(r, c)).length / head.length;
  const relevant = rows.filter((r) => isRelevant(r, c)).length;

  truths[c.id] ??= await truthCount(db, c, now);
  const truth = truths[c.id] ?? 0;
  const expected = Math.min(truth, RECALL_CAP);
  const recall = expected === 0 ? null : Math.min(1, relevant / expected);
  return {
    id: c.id,
    precision,
    recall,
    returned: rows.length,
    relevant,
    truth,
    rowsRead,
    ms,
  };
}

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Runs every case in order and returns the report. `truths` is read and filled in place. */
export async function runEval(
  db: Db,
  cases: EvalCase[],
  options: { mode: string; now: number; meter: Meter | null; truths?: TruthCache },
): Promise<Report> {
  const truths = options.truths ?? {};
  const results: CaseResult[] = [];
  for (const c of cases) {
    results.push(await runCase(db, c, options.now, options.meter, truths));
  }
  const recalls = results.flatMap((r) => (r.recall === null ? [] : [r.recall]));
  const reads = results.flatMap((r) => (r.rowsRead === null ? [] : [r.rowsRead]));
  return {
    mode: options.mode,
    at: new Date(options.now * 1000).toISOString(),
    cases: results,
    total: {
      cases: results.length,
      precision: mean(results.flatMap((r) => (r.precision === null ? [] : [r.precision]))),
      recall: mean(recalls),
      rowsRead: options.meter ? reads.reduce((a, b) => a + b, 0) : null,
      ms: results.reduce((a, r) => a + r.ms, 0),
    },
  };
}

/** A plain text table: one line per case, then the total. */
export function table(report: Report): string {
  const pct = (x: number | null) => (x === null ? "-" : `${Math.round(x * 100)}%`);
  const header = ["case", "P@20", "recall", "returned", "truth", "rows_read", "ms"];
  const lines = report.cases.map((r) => [
    r.id,
    pct(r.precision),
    pct(r.recall),
    String(r.returned),
    String(r.truth),
    r.rowsRead === null ? "-" : String(r.rowsRead),
    String(Math.round(r.ms)),
  ]);
  const total = [
    `TOTAL (${report.total.cases})`,
    pct(report.total.precision),
    pct(report.total.recall),
    "",
    "",
    report.total.rowsRead === null ? "-" : String(report.total.rowsRead),
    String(Math.round(report.total.ms)),
  ];
  const all = [header, ...lines, total];
  const widths = header.map((_, i) => Math.max(...all.map((row) => (row[i] ?? "").length)));
  const fmt = (row: string[]) =>
    row
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0)))
      .join("  ");
  return [fmt(header), ...lines.map(fmt), fmt(total)].join("\n");
}
