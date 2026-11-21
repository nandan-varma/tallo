import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RETIRE_MAX_SOURCES, type SourceConfig } from "@tallo/contracts";
import { platformFor } from "@tallo/platforms";
import { z } from "zod";

const entrySchema = z.array(
  z.object({
    key: z.string().min(1),
    company: z.string().min(1),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  }),
);

/** The reviewed hot list: an array of source ids (see `loadHot`). Not a platform file. */
export const HOT_FILE = "hot.json";

/**
 * Retirement is for boards already removed from `sources/`. Refuse any still-configured id so a typo
 * cannot delete a live board, then apply the API's per-request bound. Ids keep their given order.
 */
export function retirableSourceIds(ids: string[], configured: Iterable<string>): string[] {
  const unique = [...new Set(ids)];
  const still = new Set(configured);
  const active = unique.filter((id) => still.has(id));
  if (active.length)
    throw new Error(`Remove confirmed retired boards from sources/ first: ${active.join(", ")}`);
  if (unique.length > RETIRE_MAX_SOURCES)
    throw new Error(`Retire at most ${RETIRE_MAX_SOURCES} reviewed sources per invocation`);
  return unique;
}

/** `sources/<platform>.json`: one array of boards per platform. Trusted, reviewed configuration. */
export function loadSources(dir: string): SourceConfig[] {
  const sources: SourceConfig[] = [];
  const seen = new Set<string>();
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== HOT_FILE)
    .sort()) {
    const platform = file.slice(0, -".json".length);
    for (const entry of entrySchema.parse(JSON.parse(readFileSync(join(dir, file), "utf8")))) {
      const source: SourceConfig = {
        id: `${platform}:${entry.key}`,
        platform,
        key: entry.key,
        company: entry.company,
        params: entry.params,
      };
      if (seen.has(source.id)) throw new Error(`Duplicate source ${source.id}`);
      seen.add(source.id);
      platformFor(source); // validates platform and key
      sources.push(source);
    }
  }
  return sources;
}

/**
 * `sources/hot.json`: ids of the large employers collected daily. Every id must be a configured
 * source; a typo fails here, not silently as a board that never gets the hot tier.
 */
export function loadHot(dir: string, sources: SourceConfig[]): string[] {
  const ids = z
    .array(z.string().min(1))
    .parse(JSON.parse(readFileSync(join(dir, HOT_FILE), "utf8")));
  const known = new Set(sources.map((s) => s.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length)
    throw new Error(`${HOT_FILE} names boards not in sources/: ${unknown.join(", ")}`);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) throw new Error(`${HOT_FILE} lists ${dup[0]} twice`);
  return ids;
}
