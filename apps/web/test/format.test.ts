import { describe, expect, it } from "vitest";
import { ago } from "../src/lib/format.ts";

describe("format", () => {
  it("describes age in coarse units, and nothing when unknown", () => {
    expect(ago(1000, 1000 + 3 * 86400)).toBe("3d ago");
    expect(ago(1000, 1000 + 40 * 86400)).toBe("1mo ago");
    expect(ago(null)).toBeNull();
    expect(ago(1000, 1010)).toBe("just now");
    expect(ago(1000, 1000 + 5 * 60)).toBe("5m ago");
    expect(ago(1000, 1000 + 3 * 3600 + 59)).toBe("3h ago");
    expect(ago(2000, 1000)).toBe("just now");
  });
});
