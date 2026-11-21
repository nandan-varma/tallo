import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const BACKUP = join(REPO, "scripts/backup-d1.sh");
const LAUNCHD = join(REPO, "apps/runner/launchd");

let home: string;
let root: string;
let bin: string;

// A stand-in for wrangler. It records its calls and fakes the three commands the backup uses.
function fakeWrangler(opts: { failExport?: boolean } = {}) {
  const script = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG"
case "$1 $2" in
  "d1 execute") echo '[{"results":[{"name":"jobs"},{"name":"runs"}]}]' ;;
  "d1 export")
    ${opts.failExport ? "exit 1" : ""}
    out=""; while [ $# -gt 0 ]; do [ "$1" = "--output" ] && out="$2"; shift; done
    printf 'CREATE TABLE jobs (id integer);\\n' >"$out" ;;
  "d1 time-travel") echo '{"bookmark":"abc"}' ;;
  *) echo "unexpected: $*" >&2; exit 9 ;;
esac
`;
  const path = join(bin, "fake-wrangler");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

function runBackup(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [BACKUP, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      TALLO_BACKUP_DIR: root,
      FAKE_LOG: join(bin, "calls.log"),
      ...env,
    },
  });
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "tallo-scripts-"));
  home = join(base, "home");
  root = join(base, "backups");
  bin = join(base, "bin");
  mkdirSync(home);
  mkdirSync(bin);
});

describe("backup-d1.sh", () => {
  it("prints the plan by default and calls and writes nothing", () => {
    const wrangler = fakeWrangler();
    const r = runBackup([], { TALLO_WRANGLER: wrangler });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Dry run");
    expect(existsSync(root)).toBe(false);
    expect(existsSync(join(bin, "calls.log"))).toBe(false);
  });

  it("exports only real tables, never jobs_fts, and writes a complete backup directory", () => {
    const r = runBackup(["run"], { TALLO_WRANGLER: fakeWrangler() });
    expect(r.status, r.stderr).toBe(0);
    const dirs = readdirSync(root);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatch(/^tallo-d1-\d{8}T\d{6}Z$/);
    expect(readdirSync(join(root, dirs[0] as string)).sort()).toEqual([
      "meta.txt",
      "tallo.sql.gz",
      "time-travel.json",
    ]);
    const calls = spawnSync("cat", [join(bin, "calls.log")], { encoding: "utf8" }).stdout;
    expect(calls).toContain("--table jobs --table runs");
    expect(calls).toContain("--remote");
    // The listing query is what keeps the FTS table out of the export.
    expect(calls).toContain("NOT LIKE 'jobs\\_fts%'");
  });

  it("leaves no directory behind when the export fails", () => {
    const r = runBackup(["run"], { TALLO_WRANGLER: fakeWrangler({ failExport: true }) });
    expect(r.status).not.toBe(0);
    expect(readdirSync(root)).toEqual([]);
  });

  it("keeps the newest N backups and prunes only tallo-d1-* directories", () => {
    mkdirSync(root);
    for (const name of [
      "tallo-d1-20200101T000000Z",
      "tallo-d1-20200102T000000Z",
      "tallo-d1-20200103T000000Z",
      "unrelated",
    ]) {
      mkdirSync(join(root, name));
    }
    const r = runBackup(["run"], { TALLO_WRANGLER: fakeWrangler(), TALLO_BACKUP_KEEP: "2" });
    expect(r.status, r.stderr).toBe(0);
    const left = readdirSync(root).sort();
    expect(left).toContain("unrelated");
    expect(left).not.toContain("tallo-d1-20200101T000000Z");
    expect(left).not.toContain("tallo-d1-20200102T000000Z");
    expect(left.filter((n) => n.startsWith("tallo-d1-"))).toHaveLength(2);
  });

  it("rejects a bad retention value", () => {
    const r = runBackup(["run"], { TALLO_BACKUP_KEEP: "0" });
    expect(r.status).toBe(2);
  });
});

describe.each(["full-sync", "backup"])("%s launchd job", (job) => {
  const script = join(LAUNCHD, `${job}.sh`);
  const run = (args: string[]) =>
    spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: home },
    });

  it("prints a filled-in plist by default and installs nothing", () => {
    const r = run([]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`fyi.nandan.tallo.${job}`);
    expect(r.stdout).not.toMatch(/__[A-Z]+__/);
    expect(r.stdout).toContain(REPO.replace(/\/$/, ""));
    expect(r.stdout.replace(/<!--[\s\S]*?-->/g, "")).not.toMatch(
      /token|secret|password|api[_-]?key/i,
    );
    expect(readdirSync(home)).toEqual([]);
    expect(run(["print"]).stdout).toBe(r.stdout);
  });

  it("rejects an unknown command", () => {
    expect(run(["nope"]).status).toBe(2);
  });
});

describe("full-sync plist", () => {
  it("runs a weekly sync that treats a board as due after six days", () => {
    const r = spawnSync("bash", [join(LAUNCHD, "full-sync.sh"), "print"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: home },
    });
    expect(r.stdout).toMatch(/<string>--stale-hours<\/string>\s*<string>144<\/string>/);
    expect(r.stdout).toMatch(/<key>Weekday<\/key>\s*<integer>0<\/integer>/);
    expect(r.stdout).not.toContain("--local-egress");
  });
});
