/** Lane definitions and the control file: what the owner or the orchestrator may change while a sweep runs. */

export interface LaneSettings {
  /** Boards collected in parallel (the live value: AIMD moves it, an edit sets it). */
  concurrency: number;
  /** The most AIMD may raise `concurrency` to. */
  ceiling: number;
  /** Parallel requests to one host. */
  perHost: number;
  /** The most the controller may raise `perHost` to. */
  perHostCeiling: number;
  /** Minimum gap between request starts per host. AIMD raises it after a 429 and an edit sets it. */
  gapMs: number;
  /**
   * The smallest gap the controller may probe down to with clean boards, when it is below `gapMs`.
   * Absent: `gapMs`, so the lane never probes faster than configured. A platform `floors` gap still wins.
   */
  floorMs?: number;
  paused: boolean;
  enabled: boolean;
}

export interface LaneDef {
  name: string;
  platforms: string[];
  settings: LaneSettings;
  /** Platforms that need a tighter limit than the lane: their own host cap and start gap. */
  floors?: Record<string, { perHost?: number; gapMs?: number }>;
  /** Many hosts (a tenant or site each): a 429 slows its host, not the lane. Absent: one host, lane-wide. */
  multiHost?: boolean;
}

const lane = (
  name: string,
  platforms: string[],
  concurrency: number,
  perHost: number,
  gapMs = 0,
  floors?: LaneDef["floors"],
  perHostCeiling = perHost,
  floorMs?: number,
): LaneDef => ({
  name,
  platforms,
  settings: {
    concurrency,
    ceiling: concurrency,
    perHost,
    perHostCeiling: Math.max(perHost, perHostCeiling),
    gapMs,
    ...(floorMs === undefined ? {} : { floorMs }),
    paused: false,
    enabled: true,
  },
  ...(floors ? { floors } : {}),
});

const multiHost = (def: LaneDef): LaneDef => ({ ...def, multiHost: true });

/** Defaults from the old scripts/sweep.ts: about 30 boards in flight in total. */
export const LANES: LaneDef[] = [
  lane("greenhouse", ["greenhouse"], 5, 5, 0, undefined, 6),
  lane("lever", ["lever"], 3, 3, 0, undefined, 4),
  lane("ashby", ["ashby"], 3, 3, 0, undefined, 4),
  lane("smartrecruiters", ["smartrecruiters"], 3, 3, 0, undefined, 10),
  // 250 ms between request starts is what the fixed driver used; Workday boards are request-bound, so the
  // controller probes down to 100 ms (10 a second per pod) and backs off from there when a pod says 429.
  // Boards only wait on their own pod, so the lane keeps many pods busy at once. Measured: 6 boards left the lane
  // waiting on the limiter 70% of the time while other tenants' pods sat idle, and one board cannot exceed ~1.7
  // requests a second (Workday pages 20 postings at a time and its details wait on the pod). A pod allows 4 a
  // second at a 250 ms gap, so ~2.5 boards per pod saturate one; 105 boards spread over ~40 pods wants a wide lane.
  multiHost(lane("workday", ["workday"], 30, 2, 250, undefined, 6, 250)),
  multiHost(
    // Oracle answers 8.6 MB in 25 requests a board: source latency, not the limiter, so more boards in parallel is
    // the only lever (measured 0.46 requests a second per board with 2 boards in flight and no 429s).
    lane("oracle-icims", ["oraclecloud", "icims"], 8, 3, 250, { icims: { perHost: 3 } }, 8, 100),
  ),
  multiHost(
    lane(
      "small-ats",
      [
        "jobvite",
        "recruitee",
        "teamtailor",
        "bamboohr",
        "personio",
        "workable",
        "rippling",
        "gem",
        "pinpoint",
        "breezy",
      ],
      6,
      3,
      0,
      {
        jobvite: { perHost: 1, gapMs: 3000 },
        bamboohr: { perHost: 2, gapMs: 250 },
        personio: { perHost: 2, gapMs: 250 },
        workable: { perHost: 2, gapMs: 250 },
        breezy: { perHost: 2 },
      },
      3,
    ),
  ),
  // Walmart is latency-bound, not gap-bound: a job page takes about 0.7 s, so the old ceiling of 3 requests in
  // parallel capped it near 2 a second. 8 in parallel is ~5 a second, still one request every 200 ms at most.
  lane("walmart", ["walmart"], 1, 3, 700, undefined, 8, 250),
  lane("microsoft", ["microsoft"], 1, 2, 1000, undefined, 4),
  lane("apple", ["apple"], 1, 3, 150, undefined, 6),
  lane("meta", ["meta"], 1, 2, 500, undefined, 4, 250),
  multiHost(
    lane("big-sites", ["google", "amazon", "netflix", "ibm", "goldman"], 1, 2, 0, {
      google: { gapMs: 250 },
      amazon: { perHost: 1, gapMs: 500 },
      netflix: { perHost: 1, gapMs: 1000 },
      goldman: { perHost: 1 },
    }),
  ),
];

export interface GlobalSettings {
  maxInFlight: number;
  paused: boolean;
  stop: boolean;
}
export interface BudgetSettings {
  maxRowsWritten: number;
}
export const DEFAULT_GLOBAL: GlobalSettings = { maxInFlight: 40, paused: false, stop: false };
/** Estimated D1 rows written; at this the sweep holds every lane and asks the owner. */
export const DEFAULT_BUDGET: BudgetSettings = { maxRowsWritten: 6_000_000 };

type Check = (v: unknown) => string | undefined;
const int =
  (min: number, max: number): Check =>
  (v) =>
    typeof v === "number" && Number.isInteger(v) && v >= min && v <= max
      ? undefined
      : `must be an integer from ${min} to ${max}`;
const bool: Check = (v) => (typeof v === "boolean" ? undefined : "must be true or false");

const FIELDS: Record<"global" | "budget" | "lane", Record<string, Check>> = {
  global: { maxInFlight: int(1, 200), paused: bool, stop: bool },
  budget: { maxRowsWritten: int(1, 1e12) },
  lane: {
    concurrency: int(1, 64),
    ceiling: int(1, 64),
    perHost: int(1, 64),
    perHostCeiling: int(1, 64),
    gapMs: int(0, 600_000),
    paused: bool,
    enabled: bool,
  },
};

/** One flat edit: where it goes and what to set. */
export interface Edit {
  scope: "global" | "budget" | "lane";
  lane?: string;
  key: string;
  value: number | boolean;
}

const asObject = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/**
 * The valid edits in a control file, and a message for each invalid one. Never throws: a bad value, an
 * unknown key or lane, or a file of the wrong shape is reported and skipped.
 */
export function readEdits(
  raw: unknown,
  laneNames: readonly string[],
): { edits: Edit[]; errors: string[] } {
  const edits: Edit[] = [];
  const errors: string[] = [];
  const section = (scope: Edit["scope"], path: string, values: unknown, laneName?: string) => {
    const o = asObject(values);
    if (!o) return void errors.push(`${path} must be an object`);
    for (const [key, value] of Object.entries(o)) {
      const check = FIELDS[scope][key];
      const problem = check ? check(value) : "unknown setting";
      if (problem) errors.push(`${path}.${key}=${JSON.stringify(value)}: ${problem}`);
      else
        edits.push({
          scope,
          key,
          value: value as number | boolean,
          ...(laneName ? { lane: laneName } : {}),
        });
    }
  };
  const root = asObject(raw);
  if (!root) return { edits, errors: ["control file must be a JSON object"] };
  if (root.global !== undefined) section("global", "global", root.global);
  if (root.budget !== undefined) section("budget", "budget", root.budget);
  if (root.lanes !== undefined) {
    const lanes = asObject(root.lanes);
    if (!lanes) errors.push("lanes must be an object");
    else
      for (const [name, values] of Object.entries(lanes)) {
        if (laneNames.includes(name)) section("lane", `lanes.${name}`, values, name);
        else errors.push(`lanes.${name}: unknown lane`);
      }
  }
  return { edits, errors };
}

/** `5`, `true`, `250` from a command line word. Anything else stays a string and fails validation. */
export function parseWord(word: string): number | boolean | string {
  if (word === "true") return true;
  if (word === "false") return false;
  return word.trim() !== "" && Number.isFinite(Number(word)) ? Number(word) : word;
}
