import { env } from "cloudflare:workers";
import type { JobDetail, JobPage } from "@tallo/contracts";

/** Calls the internal API: the service binding in production, `API_URL` in local dev. */
async function call<T>(path: string): Promise<T | null> {
  const init = { headers: { authorization: `Bearer ${env.READ_TOKEN}` } };
  const response = env.API
    ? await env.API.fetch(new Request(`https://api.internal${path}`, init))
    : await fetch(`${env.API_URL}${path}`, init);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`API ${response.status} for ${path}`);
  return (await response.json()) as T;
}

export const searchJobs = (query: URLSearchParams) =>
  call<JobPage>(`/v1/jobs?${query}`) as Promise<JobPage>;
export const getJob = (id: number) => call<JobDetail>(`/v1/jobs/${id}`);
