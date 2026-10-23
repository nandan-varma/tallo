import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SourceConfig } from "@tallo/contracts";
import { platformFor } from "@tallo/platforms";
import { z } from "zod";

const entrySchema = z.array(
  z.object({
    key: z.string().min(1),
    company: z.string().min(1),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  }),
);

/** `sources/<platform>.json`: one array of boards per platform. Trusted, reviewed configuration. */
export function loadSources(dir: string): SourceConfig[] {
  const sources: SourceConfig[] = [];
  const seen = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const platform = file.slice(0, -".json".length);
    for (const entry of entrySchema.parse(JSON.parse(readFileSync(join(dir, file), "utf8")))) {
      const source: SourceConfig = { id: `${platform}:${entry.key}`, platform, key: entry.key, company: entry.company, params: entry.params };
      if (seen.has(source.id)) throw new Error(`Duplicate source ${source.id}`);
      seen.add(source.id);
      platformFor(source); // validates platform and key
      sources.push(source);
    }
  }
  return sources;
}
