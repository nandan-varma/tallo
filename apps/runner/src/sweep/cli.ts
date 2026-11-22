import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { SourceConfig } from "@tallo/contracts";
import type { Command } from "commander";
import type { Logger } from "pino";
import { createApi } from "../api.ts";
import { CLOUD_STALE_HOURS } from "../due.ts";
import { createPooledFetch } from "../net.ts";
import { createCpuPool, defaultThreads } from "../pool.ts";
import { createBoardRunner, guardedFetch, planSweep } from "./board.ts";
import { Sweep, sweepPaths } from "./controller.ts";
import { formatStatus, setControl, tailEvents } from "./report.ts";
import { LANES } from "./settings.ts";

interface Context {
  log: Logger;
  need: (name: string) => string;
  loadSources: () => SourceConfig[];
  numberFlag: (flag: string, min: number) => (raw: string) => number;
}

const defaultDir = () => process.env.TALLO_SWEEP_DIR ?? join(homedir(), "Library/Logs/tallo/sweep");
const laneNames = LANES.map((l) => l.name);

/** `tallo sweep ...`: one adaptive in-process collection with runtime control. */
export function registerSweep(program: Command, ctx: Context): void {
  const sweep = program
    .command("sweep")
    .description("Long local collection with one lane per platform group, steered at runtime");
  const dirOptions = (c: Command) =>
    c
      .option("--dir <dir>", "status, events and control files (env TALLO_SWEEP_DIR)")
      .option("--control <file>", "control file (default <dir>/control.json)");
  const paths = (opts: { dir?: string; control?: string }) =>
    sweepPaths(opts.dir ?? defaultDir(), opts.control);

  dirOptions(
    sweep
      .command("start [lane...]")
      .description(`Run the sweep (lanes: ${laneNames.join(", ")}; default all)`),
  )
    .option("--dry-run", "list due boards per lane and the first few; collect nothing")
    .option(
      "--stale-hours <h>",
      `skip boards completed within h hours (default ${CLOUD_STALE_HOURS})`,
      ctx.numberFlag("--stale-hours", 0),
      CLOUD_STALE_HOURS,
    )
    .option(
      "--threads <n>",
      "worker threads for hashing, HTML to text and gzip",
      ctx.numberFlag("--threads", 0),
    )
    .option("--no-caffeinate", "do not keep the Mac awake")
    .action(async (only: string[], opts) => {
      const unknown = only.filter((n) => !laneNames.includes(n));
      if (unknown.length)
        throw new Error(`Unknown lane ${unknown.join(", ")}. Lanes: ${laneNames.join(", ")}`);
      const net = createPooledFetch();
      let current: Sweep | undefined;
      const api = createApi(
        ctx.need("TALLO_API_URL"),
        ctx.need("TALLO_INGEST_TOKEN"),
        guardedFetch(net.fetch, () => current),
      );
      const state = new Map((await api.sources()).map((s) => [s.id, s]));
      const startedAt = Date.now();
      const work = planSweep(ctx.loadSources(), state, LANES, {
        staleHours: opts.staleHours as number,
        now: startedAt,
        only,
      });
      if (opts.dryRun) {
        for (const [name, boards] of work) {
          if (only.length && !only.includes(name)) continue;
          console.log(
            `${name.padEnd(16)}${String(boards.length).padStart(6)} due  ${boards
              .slice(0, 5)
              .map((b) => b.id)
              .join(" ")}`,
          );
        }
        await net.close();
        return;
      }
      const p = paths(opts);
      // A stale stop or pause from an earlier run must not end this one at once.
      try {
        setControl(p.control, laneNames, "global", ["stop=false", "paused=false"]);
      } catch (error) {
        throw new Error(`Cannot prepare ${p.control}: ${String(error)}`);
      }
      const threads = (opts.threads as number | undefined) ?? defaultThreads();
      const cpu = threads > 0 ? createCpuPool(threads) : undefined;
      const lanes = only.length ? LANES.filter((l) => only.includes(l.name)) : LANES;
      current = new Sweep({
        lanes,
        work,
        paths: p,
        runBoard: createBoardRunner({
          api,
          net: net.fetch,
          ...(cpu ? { cpu } : {}),
          log: ctx.log,
          runnerId: process.env.TALLO_RUNNER_ID ?? hostname(),
          version: process.env.npm_package_version ?? "dev",
          state,
        }),
      });
      const keepAwake =
        opts.caffeinate !== false && process.platform === "darwin"
          ? spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" })
          : undefined;
      keepAwake?.on("error", () => {});
      const running = current;
      let signals = 0;
      const onSignal = () => {
        if (++signals > 1) process.exit(130);
        running.stop();
      };
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      ctx.log.info(
        { control: p.control, status: p.status, events: p.events },
        "sweep running; `tallo sweep status` shows it",
      );
      const reason = await running.run();
      await cpu?.close();
      await net.close();
      keepAwake?.kill();
      ctx.log.info({ reason }, "sweep ended");
    });

  dirOptions(sweep.command("status").description("Print the sweep table and the last 15 events"))
    .option("--json", "print status.json")
    .action((opts) => {
      const p = paths(opts);
      if (!existsSync(p.status))
        throw new Error(`No sweep status at ${p.status}. Is a sweep running?`);
      const text = readFileSync(p.status, "utf8");
      if (opts.json) return void console.log(text.trimEnd());
      console.log(formatStatus(JSON.parse(text), tailEvents(p.events, 15)));
    });

  dirOptions(
    sweep
      .command("set <target> <pairs...>")
      .description(
        "Change settings of a running sweep: <lane|global|budget> key=value ... (lane: concurrency ceiling perHost gapMs paused enabled; global: maxInFlight paused stop; budget: maxRowsWritten)",
      ),
  ).action((target: string, pairs: string[], opts) => {
    const edits = setControl(paths(opts).control, laneNames, target, pairs);
    console.log(
      `${edits.length} setting${edits.length === 1 ? "" : "s"} written; the sweep reads them within 3 s`,
    );
  });

  for (const [verb, paused] of [
    ["pause", true],
    ["resume", false],
  ] as const) {
    dirOptions(
      sweep
        .command(`${verb} [lane]`)
        .description(
          `${verb === "pause" ? "Stop starting boards" : "Start boards again"} in one lane, or in all`,
        ),
    ).action((lane: string | undefined, opts) => {
      setControl(paths(opts).control, laneNames, lane ?? "global", [`paused=${paused}`]);
      console.log(`${verb}: ${lane ?? "all lanes"}`);
    });
  }

  dirOptions(
    sweep
      .command("stop")
      .description("Drain: start no more boards, let in-flight boards finish, then exit"),
  ).action((opts) => {
    setControl(paths(opts).control, laneNames, "global", ["stop=true"]);
    console.log("stop requested; boards in flight finish first");
  });
}
