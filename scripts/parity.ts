// Bounded Mac/cloud parity check: `node scripts/parity.ts [source-id]` (default lever:15five, four postings).
// Syncs the board with the Mac runner, enqueues the same board on the cloud collector, then fails unless the cloud run
// is complete, closes nothing, and leaves the catalog facts identical. Needs apps/runner/.env and wrangler login.
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

process.loadEnvFile("apps/runner/.env");
const source = process.argv[2] ?? "lever:15five";
const expected = Number(process.argv[3] ?? 4);
const headers = {
  authorization: `Bearer ${process.env.TALLO_INGEST_TOKEN}`,
  "content-type": "application/json",
};
const api = process.env.TALLO_API_URL;
async function runs() {
  const r = await fetch(`${api}/v1/runs?source=${encodeURIComponent(source)}&limit=5`, { headers });
  if (!r.ok) throw Error(`Run inspection failed: ${r.status}`);
  return r.json();
}
function snapshot() {
  const out = execFileSync(
    "pnpm",
    [
      "--filter",
      "@tallo/api",
      "exec",
      "wrangler",
      "d1",
      "execute",
      "tallo",
      "--remote",
      "--json",
      "--command",
      `SELECT posting_id,title,jd_hash,source_hash,facts,closed_at FROM jobs WHERE source_id='${source}' ORDER BY posting_id`,
    ],
    { encoding: "utf8" },
  );
  const rows = JSON.parse(out)[0].results;
  if (rows.length !== expected) throw Error(`Expected ${expected} postings, found ${rows.length}`);
  return JSON.stringify(rows);
}
const mac = spawnSync(
  "pnpm",
  [
    "--filter",
    "@tallo/runner",
    "tallo",
    "sync",
    "--source",
    source,
    "--threads",
    "0",
    "--concurrency",
    "1",
  ],
  { encoding: "utf8" },
);
writeFileSync("/tmp/tallo-parity-mac.log", mac.stdout + mac.stderr);
if (mac.status !== 0) throw Error(`Mac runner failed (${mac.status}); inspect final-mac.log`);
const before = snapshot();
const seen = new Set((await runs()).map((r) => r.id));
const enqueued = await fetch(`${api}/v1/admin/collect`, {
  method: "POST",
  headers,
  body: JSON.stringify({ sources: [source] }),
});
if (!enqueued.ok) throw Error(`Cloud enqueue failed: ${enqueued.status}`);
let cloud;
for (let i = 0; i < 30; i++) {
  const row = (await runs()).find(
    (r) => !seen.has(r.id) && r.sourceId === source && r.runnerId === "worker",
  );
  if (row?.finishedAt) {
    cloud = row;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
if (!cloud || cloud.status !== "complete" || cloud.seen !== expected || cloud.closed !== 0)
  throw Error(`Cloud check did not complete safely: ${JSON.stringify(cloud)}`);
if (snapshot() !== before) throw Error("Mac/cloud catalog facts differ");
console.log(
  JSON.stringify({
    source,
    mac: "complete",
    cloud: cloud.status,
    seen: cloud.seen,
    cloudChanged: cloud.changed,
    closed: cloud.closed,
    identicalFacts: true,
    cloudRun: cloud.id,
  }),
);
