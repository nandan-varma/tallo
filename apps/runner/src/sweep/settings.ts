/** Lane definitions and the control file: what the owner or the orchestrator may change while a sweep runs. */

export interface LaneSettings {
  /** Boards collected in parallel (the live value: AIMD moves it, an edit sets it). */
  concurrency: number;
  /** The most AIMD may raise `concurrency` to. */
  ceiling: number;
  /** Parallel requests to one host. */
  perHost: number;
  /** Minimum gap between request starts per host. AIMD raises it after a 429 and an edit sets it. */
  gapMs: number;
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
): LaneDef => ({
  name,
  platforms,
  settings: { concurrency, ceiling: concurrency, perHost, gapMs, paused: false, enabled: true },
  ...(floors ? { floors } : {}),
});

const multiHost = (def: LaneDef): LaneDef => ({ ...def, multiHost: true });

/** Defaults from the old scripts/sweep.ts: about 30 boards in flight in total. */
export const LANES: LaneDef[] = [
  lane("greenhouse", ["greenhouse"], 5, 5),
  lane("lever", ["lever"], 3, 3),
  lane("ashby", ["ashby"], 3, 3),
  lane("smartrecruiters", ["smartrecruiters"], 3, 3),
  multiHost(lane("workday", ["workday"], 6, 2, 250)),
  multiHost(lane("oracle-icims", ["oraclecloud", "icims"], 2, 2, 250)),
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
      3,
      3,
      0,
      {
        jobvite: { perHost: 1, gapMs: 3000 },
        bamboohr: { perHost: 2, gapMs: 250 },
        personio: { perHost: 2, gapMs: 250 },
        workable: { perHost: 2, gapMs: 250 },
        breezy: { perHost: 2 },
      },
    ),
  ),
  lane("walmart", ["walmart"], 1, 1, 700),
  lane("microsoft", ["microsoft"], 1, 1, 1000),
  lane("apple", ["apple"], 1, 3, 150),
  lane("meta", ["meta"], 1, 2, 500),
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
export const DEFAULT_GLOBAL: GlobalSettings = { maxInFlight: 30, paused: false, stop: false };
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
