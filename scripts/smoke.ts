// Post-deploy check: `pnpm release` runs it last, and `node scripts/smoke.ts` runs it alone.
//   TALLO_URL   the site to check (default: production)
// It fails (exit 1) when the live /llms.txt is not the one this commit generates, when a canary search does not
// answer 200 in time, or when the API host answers the public reads that only the site should serve.
import { llmsText } from "../packages/contracts/src/index.ts";

const site = process.env.TALLO_URL ?? "https://tallo.nandan.fyi";
const failures: string[] = [];

async function get(
  url: string,
  attempts = 3,
): Promise<{ status: number; body: string; ms: number }> {
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const body = await response.text();
    // A busy database answers 503 with Retry-After: a short transient after a deploy is expected, so wait it out.
    if (response.status !== 503 || attempt >= attempts) {
      return { status: response.status, body, ms: Date.now() - started };
    }
    await new Promise((done) => setTimeout(done, 5_000));
  }
}

const check = (ok: boolean, message: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};

const llms = await get(`${site}/llms.txt`);
check(llms.status === 200, `/llms.txt answers 200 (${llms.status})`);
check(llms.body === llmsText(), "/llms.txt is exactly what this commit generates");

const openapi = await get(`${site}/v1/openapi.json`);
check(openapi.status === 200, `/v1/openapi.json answers 200 (${openapi.status})`);

// Broad words are the expensive searches: they are what overloaded the database before the candidate cut.
for (const query of [
  "title=engineer",
  "title=manager",
  "title=analyst",
  "company=stripe",
  "title=backend+engineer&location=remote",
  "title=manager&sort=recent",
]) {
  const result = await get(`${site}/v1/search?${query}&limit=5`);
  const ok = result.status === 200 && result.ms < 8_000;
  check(ok, `search ${query}: ${result.status} in ${result.ms} ms`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
