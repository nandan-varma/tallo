import type { Cpu } from "@tallo/collect";
import type { SourceConfig } from "@tallo/contracts";
import type { Logger } from "pino";
import type { Api } from "../api.ts";
import type { SourceState } from "../due.ts";
import { dueSources } from "../due.ts";
import { syncSource } from "../sync.ts";
import { parseRetryAfter } from "./classify.ts";
import type { Cost, RunBoard, Sweep } from "./controller.ts";
import type { LaneDef } from "./settings.ts";

/** Rough D1 rows per posting written: a new posting touches about 20, a changed one 3, a closed one 5. */
const ROWS_NEW = 20;
const ROWS_CHANGED = 3;
const ROWS_CLOSED = 5;
const ROWS_RUN = 8;

/** Estimated cost of one run: rows written (D1) and objects put (R2). Never-synced boards write new rows. */
export function estimateCost(usage: {
  applied: number;
  closed: number;
  descriptions: number;
  rawPacks: number;
  firstRun: boolean;
}): Cost {
  const perPosting = usage.firstRun ? ROWS_NEW : ROWS_CHANGED;
  return {
    rows: ROWS_RUN + usage.applied * perPosting + usage.closed * ROWS_CLOSED,
    r2Puts: usage.descriptions + usage.rawPacks,
  };
}

/**
 * Due boards by lane. Computed once, with the staleness horizon fixed at `now`: boards completed after
 * it are never due again, and boards that age out later are not queued. Order is dueSources' order:
 * never synced first, then the oldest completed run.
 */
export function planSweep(
  configured: SourceConfig[],
  state: Map<string, SourceState>,
  lanes: LaneDef[],
  options: { staleHours: number; now: number; only?: string[] },
): Map<string, SourceConfig[]> {
  const due = dueSources(configured, state, {
    cutoff: options.now / 1000 - options.staleHours * 3600,
    now: options.now / 1000,
  });
  const laneOf = new Map(lanes.flatMap((l) => l.platforms.map((p) => [p, l.name] as const)));
  const work = new Map<string, SourceConfig[]>(lanes.map((l) => [l.name, []]));
  for (const source of due) {
    const lane = laneOf.get(source.platform);
    if (lane && (!options.only?.length || options.only.includes(lane)))
      work.get(lane)?.push(source);
  }
  return work;
}

interface BoardDeps {
  api: Api;
  net: typeof fetch;
  cpu?: Cpu;
  log: Logger;
  runnerId: string;
  version: string;
  state: Map<string, SourceState>;
}

/** The host a fetch goes to, or undefined when the input has no parseable URL. */
function hostOf(input: Parameters<typeof fetch>[0]): string | undefined {
  try {
    return new URL(typeof input === "string" || input instanceof URL ? input : input.url).host;
  } catch {
    return undefined;
  }
}

/** The real board runner: `syncSource` through the lane's limiter, watching the lane's responses. */
export function createBoardRunner(deps: BoardDeps): RunBoard {
  return async (source, lane) => {
    const usage = { applied: 0, closed: 0, descriptions: 0, rawPacks: 0 };
    const laneFetch: typeof fetch = async (input, init) => {
      const response = await deps.net(input, init);
      lane.observe(
        response.status,
        parseRetryAfter(response.headers.get("retry-after")),
        Date.now(),
        hostOf(input),
      );
      return response;
    };
    const api: Api = {
      ...deps.api,
      applyJobs: async (runId, jobs) => {
        const result = await deps.api.applyJobs(runId, jobs);
        usage.applied += result.applied;
        return result;
      },
      putJd: async (hash, gz) => {
        await deps.api.putJd(hash, gz);
        usage.descriptions++;
      },
      putRaw: async (runId, gz) => {
        const key = await deps.api.putRaw(runId, gz);
        usage.rawPacks++;
        return key;
      },
      finalize: async (runId, body) => {
        const result = await deps.api.finalize(runId, body);
        usage.closed += result.closed;
        return result;
      },
    };
    const outcome = await syncSource(source, {
      api,
      log: deps.log,
      limiter: lane.limiterFor(source.platform),
      detailConcurrency: lane.detailConcurrency(source.platform),
      fetch: laneFetch,
      ...(deps.cpu ? { cpu: deps.cpu } : {}),
      runnerId: deps.runnerId,
      version: deps.version,
    });
    const firstRun = !deps.state.get(source.id)?.lastCompleteRunAt;
    return { outcome, cost: estimateCost({ ...usage, firstRun }) };
  };
}

/**
 * A fetch for the ingest API that reports each response and its latency to the sweep's D1 guard. Planning reads the
 * source list before the sweep exists, so the sweep may be absent.
 */
export function guardedFetch(base: typeof fetch, sweep: () => Sweep | undefined): typeof fetch {
  return async (input, init) => {
    const started = Date.now();
    try {
      const response = await base(input, init);
      sweep()?.observeApi(
        response.status,
        Date.now() - started,
        parseRetryAfter(response.headers.get("retry-after")),
      );
      return response;
    } catch (error) {
      sweep()?.observeApi(0, Date.now() - started);
      throw error;
    }
  };
}
