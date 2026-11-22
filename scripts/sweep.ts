// Run a full local collection as separate jobs, one process per platform group, and show how each is doing.
//
//   node scripts/sweep.ts start [job ...]   run the named jobs (default: all) until they finish; Ctrl-C or SIGTERM stops
//   node scripts/sweep.ts status            print the table from the status file (safe to run any time)
//   node scripts/sweep.ts plan              print the jobs and their settings
//
// Why separate jobs: every platform has its own hosts and its own rate limits, so a 429 on one platform slows only its
// own job while the others keep going. Inside a job, `tallo sync` takes never-synced boards first (oldest completed run
// first, and never is oldest), then the rest. A board that fails or ends partial is picked up by the next pass of the
// same job, after a cool-off, with half the concurrency: the sweep gets back to it instead of hammering a limited host.
// A pass that fixes nothing ends the job ("stuck"): those boards need a look, not another retry.
//
// Needs apps/runner/.env (TALLO_API_URL, TALLO_INGEST_TOKEN). Nothing here is scheduled: it runs when you start it.
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

interface Step {
  platform: string;
  /** Boards collected in parallel on the first pass; later passes halve it. */
  concurrency: number;
  /** Parallel requests to one host, and the minimum gap between request starts (see packages/collect/src/policy.ts). */
  perHost: number;
  gapMs?: number;
  /** Worker threads for hashing, HTML to text and gzip. */
  threads?: number;
}
interface Job {
  name: string;
  steps: Step[];
}

// About 30 boards in flight in total: the ingest API and D1 take the writes of all jobs together.
const JOBS: Job[] = [
  {
    name: "greenhouse",
    steps: [{ platform: "greenhouse", concurrency: 5, perHost: 5, threads: 2 }],
  },
  { name: "lever", steps: [{ platform: "lever", concurrency: 3, perHost: 3 }] },
  { name: "ashby", steps: [{ platform: "ashby", concurrency: 3, perHost: 3 }] },
  { name: "smartrecruiters", steps: [{ platform: "smartrecruiters", concurrency: 3, perHost: 3 }] },
  {
    name: "workday",
    steps: [{ platform: "workday", concurrency: 6, perHost: 2, gapMs: 250, threads: 2 }],
  },
  {
    name: "oracle-icims",
    steps: [
      { platform: "oraclecloud", concurrency: 2, perHost: 2, gapMs: 250 },
      { platform: "icims", concurrency: 2, perHost: 2, gapMs: 250 },
    ],
  },
  {
    name: "small-ats",
    steps: [
      { platform: "jobvite", concurrency: 1, perHost: 1, gapMs: 3000 },
      { platform: "recruitee", concurrency: 3, perHost: 3 },
      { platform: "teamtailor", concurrency: 3, perHost: 3 },
      { platform: "bamboohr", concurrency: 2, perHost: 2, gapMs: 250 },
      { platform: "personio", concurrency: 2, perHost: 2, gapMs: 250 },
      { platform: "workable", concurrency: 2, perHost: 2, gapMs: 250 },
      { platform: "rippling", concurrency: 3, perHost: 3 },
      { platform: "gem", concurrency: 3, perHost: 3 },
      { platform: "pinpoint", concurrency: 3, perHost: 3 },
      { platform: "breezy", concurrency: 2, perHost: 2 },
    ],
  },
  { name: "walmart", steps: [{ platform: "walmart", concurrency: 1, perHost: 1, gapMs: 700 }] },
  {
    name: "microsoft",
    steps: [{ platform: "microsoft", concurrency: 1, perHost: 1, gapMs: 1000 }],
  },
  { name: "apple", steps: [{ platform: "apple", concurrency: 1, perHost: 3, gapMs: 150 }] },
  { name: "meta", steps: [{ platform: "meta", concurrency: 1, perHost: 2, gapMs: 500 }] },
  {
    name: "big-sites",
    steps: [
      { platform: "google", concurrency: 1, perHost: 2, gapMs: 250 },
      { platform: "amazon", concurrency: 1, perHost: 1, gapMs: 500 },
      { platform: "netflix", concurrency: 1, perHost: 1, gapMs: 1000 },
      { platform: "ibm", concurrency: 1, perHost: 2 },
      { platform: "goldman", concurrency: 1, perHost: 1 },
    ],
  },
];

const MAX_PASSES = 4;
const COOL_OFF_SECONDS = 120;

type State = "queued" | "running" | "cooling" | "done" | "stuck" | "failed";
interface JobStatus {
  name: string;
  state: State;
  step: string;
  pass: number;
  due: number;
  done: number;
  failed: number;
  requests: number;
  rateLimited: number;
  startedAt: number | null;
  finishedAt: number | null;
  coolUntil: number | null;
  /** Boards completed per minute in the running pass, and the remaining time that implies. */
  perMinute: number;
  etaSeconds: number | null;
  note: string;
}

const LOG_DIR = join(homedir(), "Library", "Logs", "tallo", "sweep");
const STATUS_FILE = join(LOG_DIR, "status.json");
const REPO = new URL("..", import.meta.url).pathname;

function loadEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const file = join(REPO, "apps/runner/.env");
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`Missing ${file} (TALLO_API_URL and TALLO_INGEST_TOKEN)`);
  }
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match && !line.trim().startsWith("#")) {
      env[match[1] as string] = (match[2] as string).replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

const statuses = new Map<string, JobStatus>();
const children = new Set<ChildProcess>();
let stopping = false;

function writeStatus() {
  const body = JSON.stringify(
    { updatedAt: Date.now(), pid: process.pid, jobs: [...statuses.values()] },
    null,
    1,
  );
  writeFileSync(`${STATUS_FILE}.tmp`, body);
  renameSync(`${STATUS_FILE}.tmp`, STATUS_FILE);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One `tallo sync` pass over a platform. Resolves with how it ended; counts come from its JSON log lines. */
function pass(
  job: JobStatus,
  step: Step,
  passNumber: number,
  env: NodeJS.ProcessEnv,
): Promise<{ due: number; incomplete: number }> {
  const concurrency = Math.max(1, Math.floor(step.concurrency / 2 ** (passNumber - 1)));
  const gapMs = (step.gapMs ?? 0) * 2 ** (passNumber - 1);
  const args = [
    "--filter",
    "@tallo/runner",
    "tallo",
    "sync",
    "-p",
    step.platform,
    "-c",
    String(concurrency),
    "--per-host",
    String(step.perHost),
    "--host-interval-ms",
    String(gapMs),
    "--threads",
    String(step.threads ?? 1),
  ];
  const log = createWriteStream(
    join(LOG_DIR, `${job.name}-${step.platform}-pass${passNumber}.log`),
  );
  const child = spawn("pnpm", args, { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  const result = { due: 0, incomplete: 0 };
  const startedAt = Date.now();
  let doneThisPass = 0;
  const read = (line: string) => {
    log.write(`${line}\n`);
    if (line.includes("429")) job.rateLimited++;
    let entry: { msg?: string; due?: number; incomplete?: number; requests?: number } = {};
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (entry.msg === "starting sync") {
      result.due = entry.due ?? 0;
      job.due = result.due;
      job.done = 0;
      job.failed = 0;
    } else if (entry.msg === "synced") {
      doneThisPass++;
      job.done = doneThisPass;
      job.requests += entry.requests ?? 0;
    } else if (entry.msg === "sync failed" || entry.msg === "listing failed") {
      job.failed++;
    } else if (entry.msg === "sync finished") {
      result.incomplete = entry.incomplete ?? 0;
    }
    const minutes = (Date.now() - startedAt) / 60_000;
    job.perMinute = minutes > 0.2 ? Math.round((doneThisPass / minutes) * 10) / 10 : 0;
    job.etaSeconds =
      job.perMinute > 0
        ? Math.round(((job.due - doneThisPass - job.failed) / job.perMinute) * 60)
        : null;
  };
  createInterface({ input: child.stdout }).on("line", read);
  createInterface({ input: child.stderr }).on("line", read);
  return new Promise((resolve) => {
    child.on("close", () => {
      children.delete(child);
      log.end();
      resolve(result);
    });
  });
}

async function runJob(job: Job, env: NodeJS.ProcessEnv) {
  const status = statuses.get(job.name) as JobStatus;
  status.startedAt = Date.now();
  for (const step of job.steps) {
    status.step = step.platform;
    status.requests = 0;
    let previous = Number.POSITIVE_INFINITY;
    for (let passNumber = 1; passNumber <= MAX_PASSES && !stopping; passNumber++) {
      status.state = "running";
      status.pass = passNumber;
      status.note = "";
      const { due, incomplete } = await pass(status, step, passNumber, env);
      if (stopping) return;
      if (due === 0 || incomplete === 0) {
        status.note = due === 0 ? "nothing due" : "";
        break;
      }
      if (incomplete >= previous) {
        status.state = "stuck";
        status.note = `${incomplete} board(s) of ${step.platform} still fail; see the pass logs`;
        break;
      }
      previous = incomplete;
      if (passNumber === MAX_PASSES) {
        status.state = "stuck";
        status.note = `${incomplete} board(s) of ${step.platform} left after ${MAX_PASSES} passes`;
        break;
      }
      // Come back to the boards that failed or ended partial after a cool-off, slower than before.
      const cool = COOL_OFF_SECONDS * passNumber;
      status.state = "cooling";
      status.coolUntil = Date.now() + cool * 1000;
      status.note = `${incomplete} to retry at ${Math.max(1, Math.floor(step.concurrency / 2 ** passNumber))} at a time`;
      await sleep(cool * 1000);
      status.coolUntil = null;
    }
  }
  if (status.state === "running" || status.state === "cooling") status.state = "done";
  status.finishedAt = Date.now();
  status.etaSeconds = 0;
}

const fmt = (seconds: number | null) => {
  if (seconds === null) return "?";
  if (seconds <= 0) return "0";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
};

function table(jobs: JobStatus[]): string {
  const rows = jobs.map((j) => [
    j.name,
    j.state +
      (j.state === "cooling" && j.coolUntil
        ? ` ${fmt(Math.round((j.coolUntil - Date.now()) / 1000))}`
        : ""),
    j.step || "-",
    `${j.pass}`,
    `${j.done}/${j.due}`,
    `${j.failed}`,
    `${j.requests}`,
    `${j.rateLimited}`,
    `${j.perMinute}/min`,
    j.state === "running" ? fmt(j.etaSeconds) : j.state === "done" ? "done" : "-",
    j.note,
  ]);
  const head = [
    "job",
    "state",
    "platform",
    "pass",
    "boards",
    "failed",
    "requests",
    "429s",
    "rate",
    "eta",
    "note",
  ];
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] as string).length)),
  );
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] as number)).join("  ");
  return [line(head), ...rows.map(line)].join("\n");
}

async function start(names: string[]) {
  mkdirSync(LOG_DIR, { recursive: true });
  const env = loadEnv();
  const jobs = names.length ? JOBS.filter((j) => names.includes(j.name)) : JOBS;
  if (jobs.length === 0)
    throw new Error(`No such job. Jobs: ${JOBS.map((j) => j.name).join(", ")}`);
  for (const job of jobs) {
    statuses.set(job.name, {
      name: job.name,
      state: "queued",
      step: "",
      pass: 0,
      due: 0,
      done: 0,
      failed: 0,
      requests: 0,
      rateLimited: 0,
      startedAt: null,
      finishedAt: null,
      coolUntil: null,
      perMinute: 0,
      etaSeconds: null,
      note: "",
    });
  }
  // Keep the Mac awake while the sweep runs; caffeinate exits with this process.
  spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" }).unref();
  const stop = () => {
    stopping = true;
    for (const child of children) child.kill("SIGTERM");
    for (const s of statuses.values())
      if (s.state === "running" || s.state === "cooling")
        (s.state = "failed"), (s.note = "stopped");
    writeStatus();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const ticker = setInterval(writeStatus, 5000);
  writeStatus();
  await Promise.all(jobs.map((job, i) => sleep(i * 20_000).then(() => runJob(job, env))));
  clearInterval(ticker);
  writeStatus();
  console.log(table([...statuses.values()]));
}

function status() {
  const file = JSON.parse(readFileSync(STATUS_FILE, "utf8")) as {
    updatedAt: number;
    pid: number;
    jobs: JobStatus[];
  };
  const age = Math.round((Date.now() - file.updatedAt) / 1000);
  console.log(`${table(file.jobs)}\n\nupdated ${age}s ago (sweep pid ${file.pid})`);
  const open = file.jobs.filter((j) => j.state === "running" || j.state === "cooling");
  const longest = Math.max(0, ...open.map((j) => j.etaSeconds ?? 0));
  console.log(
    open.length
      ? `${open.length} job(s) active; the longest running job ends in about ${fmt(longest)}`
      : "no active jobs",
  );
}

const [command = "status", ...rest] = process.argv.slice(2);
if (command === "start") await start(rest);
else if (command === "status") status();
else if (command === "plan") console.log(JSON.stringify(JOBS, null, 1));
else throw new Error("Usage: node scripts/sweep.ts start [job ...] | status | plan");
