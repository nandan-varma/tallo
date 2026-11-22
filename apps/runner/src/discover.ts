import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SourceConfig } from "@tallo/contracts";
import { platformFor } from "@tallo/platforms";
import type { Verification } from "./verify.ts";

interface Board {
  platform: string;
  key: string;
  params: Record<string, string>;
}

/** Careers-page URL shapes whose first capture is the board key (see docs/adding-sources.md). */
const SHAPES: { platform: string; re: RegExp; params?: Record<string, string> }[] = [
  { platform: "greenhouse", re: /^(?:job-)?boards\.greenhouse\.io\/([\w-]+)/ },
  {
    platform: "greenhouse",
    re: /^(?:job-)?boards\.eu\.greenhouse\.io\/([\w-]+)/,
    params: { region: "eu" },
  },
  { platform: "lever", re: /^jobs\.lever\.co\/([\w-]+)/ },
  { platform: "lever", re: /^jobs\.eu\.lever\.co\/([\w-]+)/, params: { region: "eu" } },
  { platform: "ashby", re: /^jobs\.ashbyhq\.com\/([\w.-]+)/ },
  { platform: "smartrecruiters", re: /^(?:careers|jobs)\.smartrecruiters\.com\/([\w-]+)/ },
  { platform: "workable", re: /^apply\.workable\.com\/([\w-]+)/ },
  { platform: "rippling", re: /^ats\.rippling\.com\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?([\w-]+)\/jobs/ },
  { platform: "gem", re: /^jobs\.gem\.com\/([\w-]+)/ },
  { platform: "pinpoint", re: /^([a-z0-9-]+)\.pinpointhq\.com/ },
  { platform: "breezy", re: /^([a-z0-9-]+)\.breezy\.hr/ },
  { platform: "recruitee", re: /^([a-z0-9-]+)\.recruitee\.com/ },
  { platform: "teamtailor", re: /^([a-z0-9-]+)\.teamtailor\.com/ },
  { platform: "personio", re: /^([a-z0-9-]+)\.jobs\.personio\.(?:de|com)/ },
  { platform: "bamboohr", re: /^([a-z0-9-]+)\.bamboohr\.com\/(?:careers|jobs)/ },
];

/** Subdomains of those hosts that are the vendor's own sites, not employers. */
const VENDOR = new Set([
  "www",
  "app",
  "api",
  "jobs",
  "careers",
  "help",
  "support",
  "blog",
  "trends",
]);

/** The board a careers URL points at, or undefined when it is not a known ATS shape. */
export function boardOfUrl(raw: string): Board | undefined {
  const url = raw.trim().replace(/^https?:\/\//i, "");
  for (const { platform, re, params } of SHAPES) {
    const key = re.exec(url)?.[1];
    if (key && !VENDOR.has(key)) return { platform, key, params: params ?? {} };
  }
  return undefined;
}

/** Display name stand-in: the slug in words. Review it: the name users recognize wins. */
const nameOf = (key: string) =>
  key
    .replace(/^-+/, "")
    .split(/[-_]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

export interface Discovery {
  /** Boards that listed jobs and mapped without warnings. */
  accepted: SourceConfig[];
  rejected: { id: string; reason: string }[];
  /** URLs that match no known ATS shape. */
  unrecognized: string[];
  /** Boards already configured. */
  known: number;
}

/**
 * Turn a list of careers URLs into verified, not-yet-configured boards. Nothing is written here and
 * every board is dry-run through `verifySource` (the same check as `tallo verify`).
 */
export async function discover(
  urls: string[],
  configured: Iterable<string>,
  verify: (source: SourceConfig) => Promise<Pick<Verification, "listed" | "issues" | "warnings">>,
): Promise<Discovery> {
  const have = new Set(configured);
  const out: Discovery = { accepted: [], rejected: [], unrecognized: [], known: 0 };
  const seen = new Set<string>();
  for (const url of urls.map((u) => u.trim()).filter(Boolean)) {
    const board = boardOfUrl(url);
    if (!board) {
      out.unrecognized.push(url);
      continue;
    }
    const id = `${board.platform}:${board.key}`;
    if (seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    if (have.has(id)) {
      out.known++;
      continue;
    }
    const source: SourceConfig = { id, ...board, company: nameOf(board.key) };
    try {
      platformFor(source).validate(source);
      const v = await verify(source);
      if (v.listed === 0) out.rejected.push({ id, reason: "no postings" });
      else if (v.issues.length || v.warnings.length)
        out.rejected.push({
          id,
          reason: [...v.warnings, ...v.issues.map((i) => i.message)].join("; "),
        });
      else out.accepted.push(source);
    } catch (error) {
      out.rejected.push({ id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}

/** Add accepted boards to `sources/<platform>.json`, keeping each file sorted by key. */
export function writeAccepted(dir: string, accepted: SourceConfig[]): void {
  for (const platform of new Set(accepted.map((s) => s.platform))) {
    const file = join(dir, `${platform}.json`);
    const entries = JSON.parse(readFileSync(file, "utf8")) as {
      key: string;
      company: string;
      params?: SourceConfig["params"];
    }[];
    for (const s of accepted.filter((a) => a.platform === platform))
      entries.push({
        key: s.key,
        company: s.company,
        ...(Object.keys(s.params).length ? { params: s.params } : {}),
      });
    entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
  }
}
