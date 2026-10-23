// One-off: seed sources/*.json from the legacy EveryRole registry (data only, no legacy code).
// Usage: node scripts/import-legacy-sites.mjs ~/dev/EveryRole/pipeline/sites.json
import { readFileSync, writeFileSync } from "node:fs";

const PLATFORMS = ["greenhouse", "lever", "ashby", "smartrecruiters", "workday"];
const sites = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = Object.fromEntries(PLATFORMS.map((p) => [p, []]));

for (const site of sites) {
  if (!PLATFORMS.includes(site.platform)) continue;
  if (site.platform === "workday") {
    const { tenant, wd, site: board } = site.workday ?? {};
    if (!tenant || !wd || !board) continue;
    out.workday.push({ key: `${tenant}/${board}`, company: site.name, params: { wd } });
  } else {
    out[site.platform].push({ key: site.slug, company: site.name });
  }
}
for (const [platform, entries] of Object.entries(out)) {
  const unique = [...new Map(entries.map((e) => [e.key.toLowerCase(), e])).values()].sort((a, b) =>
    a.key.localeCompare(b.key),
  );
  writeFileSync(`sources/${platform}.json`, `${JSON.stringify(unique, null, 1)}\n`);
  console.log(platform, unique.length);
}
