import type { Application } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { afterApplyClick, countByStatus, filterByStatus, needsFollowUp } from "@/lib/tracker";

const app = (jobId: number, status: Application["status"]): Application => ({
  jobId,
  status,
  note: "",
  title: `Role ${jobId}`,
  company: "Acme",
  location: null,
  applyUrl: null,
  createdAt: 1,
  updatedAt: 1,
  appliedAt: null,
});

describe("tracker helpers", () => {
  const all = [app(1, "saved"), app(2, "applied"), app(3, "applied"), app(4, "rejected")];

  it("counts every status, including empty ones", () => {
    expect(countByStatus(all)).toEqual({
      all: 4,
      saved: 1,
      applied: 2,
      interviewing: 0,
      offer: 0,
      rejected: 1,
    });
  });

  it("filters by status, and `all` keeps everything", () => {
    expect(filterByStatus(all, "applied").map((a) => a.jobId)).toEqual([2, 3]);
    expect(filterByStatus(all, "offer")).toEqual([]);
    expect(filterByStatus(all, "all")).toBe(all);
  });

  it("nudges to follow up on an application with no update for a week", () => {
    const day = 86_400;
    const applied = { ...app(1, "applied"), appliedAt: 100, updatedAt: 100 };
    expect(needsFollowUp(applied, 100 + 6 * day)).toBe(false);
    expect(needsFollowUp(applied, 100 + 7 * day)).toBe(true);
    expect(needsFollowUp({ ...applied, status: "interviewing" }, 100 + 30 * day)).toBe(false);
    expect(needsFollowUp({ ...applied, appliedAt: null, status: "saved" }, 100 + 30 * day)).toBe(
      false,
    );
  });

  it("clicking Apply moves an untracked or saved role to applied, and never overrides a later status", () => {
    expect(afterApplyClick(undefined)).toBe("applied");
    expect(afterApplyClick("saved")).toBe("applied");
    expect(afterApplyClick("interviewing")).toBeNull();
    expect(afterApplyClick("offer")).toBeNull();
    expect(afterApplyClick("applied")).toBeNull();
  });
});
