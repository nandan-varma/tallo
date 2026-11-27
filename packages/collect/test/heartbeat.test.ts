import { describe, expect, it } from "vitest";
import { createHeartbeat } from "../src/heartbeat.ts";

function setup(intervalMs = 30_000) {
  let now = 0;
  const lines: { obj: Record<string, unknown>; msg?: string }[] = [];
  const log = {
    info: (obj: object, msg?: string) =>
      void lines.push({ obj: obj as Record<string, unknown>, ...(msg ? { msg } : {}) }),
  };
  const beat = createHeartbeat(log, { source: "greenhouse:acme" }, 100, {
    intervalMs,
    now: () => now,
  });
  const advance = (ms: number): void => {
    now += ms;
  };
  return { beat, advance, lines };
}

describe("createHeartbeat", () => {
  it("is silent before the interval has passed", () => {
    const { beat, advance, lines } = setup();
    for (let done = 1; done <= 5; done++) {
      advance(1000);
      beat(done);
    }
    expect(lines).toEqual([]);
  });

  it("logs the count, the total and the rate once the interval has passed", () => {
    const { beat, advance, lines } = setup();
    advance(30_000);
    beat(60);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.msg).toBe("progress");
    expect(lines[0]?.obj).toEqual({
      source: "greenhouse:acme",
      done: 60,
      total: 100,
      perMinute: 120,
      elapsedSec: 30,
    });
  });

  it("measures the rate over the last interval, not the whole run", () => {
    const { beat, advance, lines } = setup();
    advance(30_000);
    beat(60);
    advance(30_000);
    beat(70);
    expect(lines[1]?.obj).toMatchObject({ done: 70, perMinute: 20, elapsedSec: 60 });
  });

  it("logs at most once per interval however often it is called", () => {
    const { beat, advance, lines } = setup();
    advance(31_000);
    for (let done = 1; done <= 50; done++) beat(done);
    expect(lines).toHaveLength(1);
  });
});
