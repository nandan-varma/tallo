import { readFileSync } from "node:fs";
import type {
  CollectContext,
  Http,
  HttpResponse,
  Issue,
  Json,
  SourceConfig,
} from "@tallo/contracts";

export const fixture = (name: string): Json =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

export const source = (
  platform: string,
  key: string,
  params: SourceConfig["params"] = {},
): SourceConfig => ({
  id: `${platform}:${key}`,
  platform,
  key,
  company: key,
  params,
});

type Handler = (url: string, body?: Json) => Json;

/** Fake Http serving `handler(url, body)` and counting requests. */
export function fakeCtx(handler: Handler): {
  ctx: CollectContext;
  urls: string[];
  issues: Issue[];
} {
  const urls: string[] = [];
  const issues: Issue[] = [];
  const respond = (url: string, body?: Json): HttpResponse => {
    urls.push(url);
    return { status: 200, url, data: handler(url, body) };
  };
  const http: Http = {
    getJson: async (url) => respond(url),
    postJson: async (url, body) => respond(url, body),
    getText: async (url) => ({ ...respond(url), data: "" }),
  };
  return { ctx: { http, maxPostings: 1_000_000, record: (i) => issues.push(i) }, urls, issues };
}

export async function drain<T, R>(gen: AsyncGenerator<T, R>): Promise<{ items: T[]; result: R }> {
  const items: T[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { items, result: next.value };
    items.push(next.value);
  }
}

/** Fake Http whose `getText` answers `body` (for XML/HTML sources). */
export function textCtx(body: string): { ctx: CollectContext; urls: string[] } {
  const urls: string[] = [];
  const http: Http = {
    getJson: async () => {
      throw new Error("unexpected getJson");
    },
    postJson: async () => {
      throw new Error("unexpected postJson");
    },
    getText: async (url) => {
      urls.push(url);
      return { status: 200, url, data: body };
    },
  };
  return { ctx: { http, maxPostings: 1_000_000, record: () => {} }, urls };
}

export const textFixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
