// Post-deploy check: `pnpm release` runs it last, and `node scripts/smoke.ts` runs it alone.
//   TALLO_URL   the site to check (default: production)
// It fails (exit 1) when the live /llms.txt is not the one this commit generates, when a canary search does not
// answer 200 in time, or when the API host answers the public reads that only the site should serve.
import {
  llmsText,
  publicErrorSchema,
  publicSearchPageSchema,
} from "../packages/contracts/src/index.ts";

async function get(
  url: string,
  attempts = 3,
): Promise<{ status: number; body: string; ms: number; type: string }> {
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const body = await response.text();
    // A busy database answers 503 with Retry-After: a short transient after a deploy is expected, so wait it out.
    if (response.status !== 503 || attempt >= attempts) {
      return {
        status: response.status,
        body,
        ms: Date.now() - started,
        type: response.headers.get("content-type") ?? "",
      };
    }
    await new Promise((done) => setTimeout(done, 5_000));
  }
}

export async function smoke(
  site = process.env.TALLO_URL ?? "https://tallo.nandan.fyi",
  api = process.env.TALLO_API_URL ?? "https://tallo-api.nandan.fyi",
) {
  const failures: string[] = [];
  const check = (ok: boolean, message: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
    if (!ok) failures.push(message);
  };

  const llms = await get(`${site}/llms.txt`);
  check(llms.status === 200, `/llms.txt answers 200 (${llms.status})`);
  check(llms.body === llmsText(), "/llms.txt is exactly what this commit generates");
  check(/charset=utf-8/i.test(llms.type), `/llms.txt is served as UTF-8 text (${llms.type})`);

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
    let valid = false;
    try {
      valid = publicSearchPageSchema.safeParse(JSON.parse(result.body)).success;
    } catch {}
    const ok = result.status === 200 && valid && result.ms < 8_000;
    check(ok, `search ${query}: ${result.status} in ${result.ms} ms`);
  }

  for (const path of [
    "/v1/search?title=engineer",
    "/v1/jobs/1",
    "/v1/jobs/1/description",
    "/v1/companies",
    "/v1/titles",
    "/v1/openapi.json",
  ]) {
    const response = await get(`${api}${path}`);
    let valid = false;
    try {
      valid = publicErrorSchema.safeParse(JSON.parse(response.body)).success;
    } catch {}
    check(response.status === 404 && valid, `API host refuses ${path}: ${response.status}`);
  }
  if (failures.length > 0) throw new Error(`${failures.length} release check(s) failed`);
}

if (import.meta.main) await smoke();
