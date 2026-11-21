import { describe, expect, it } from "vitest";
import { jobvite, platformFor, SchemaError } from "../src/index.ts";
import { drain, source, textCtx, textFixture } from "./helpers.ts";

describe("jobvite", () => {
  const src = source("jobvite", "qXJ9Vfwu");
  it("lists every <job> of the one-request feed and maps it", async () => {
    const { ctx, urls } = textCtx(textFixture("jobvite-feed.xml"));
    const { items, result } = await drain(jobvite.list(src, ctx));
    expect(urls).toEqual(["https://app.jobvite.com/CompanyJobs/Xml.aspx?c=qXJ9Vfwu"]);
    expect(items.map((i) => i.id)).toEqual(["o3J1Afw7-CetEXfw2", "o3J1Afw7"]);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: false });
    const job = jobvite.map(items[1]!, src);
    expect(job.title).toBe("Channel Account Manager");
    expect(job.requisitionId).toBe("6650");
    expect(job.employmentType).toBe("Regular");
    expect(job.department).toBe("Sales-Channel - APJ - 4600501");
    expect(job.postedAt).toBe("2026-11-01");
    expect(job.url).toContain("Job.aspx?c=qXJ9Vfwu&j=o3J1Afw7");
    expect(job.applyUrl).toContain("k=Apply");
    expect(JSON.stringify(job.locations)).toContain("Sydney");
    expect(job.description).toContain("Shape the Future of Cybersecurity");
    expect(job.compensation).toEqual([]);
    expect(job.extras).toMatchObject({ region: "APJ", category: "Sales" });
    expect(jobvite.map(items[0]!, src).extras.parentId).toBe("o3J1Afw7");
  });
  it("handles a feed with a single job and does not guess an invalid date", async () => {
    const xml =
      "<result><job><id>a1</id><title>Cook</title><category>Kitchen</category><date>2/30/2026</date></job></result>";
    const { items } = await drain(jobvite.list(src, textCtx(xml).ctx));
    expect(items).toHaveLength(1);
    const job = jobvite.map(items[0]!, src);
    expect(job.department).toBe("Kitchen");
    expect(job.postedAt).toBeUndefined();
  });
  it("treats an empty feed as complete but not authoritative", async () => {
    const { items, result } = await drain(jobvite.list(src, textCtx("<result />").ctx));
    expect(items).toEqual([]);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: false });
  });
  it("treats unexpected bodies as a failed run, not an empty board", async () => {
    for (const body of [
      "<html><body>nope</body></html>",
      "",
      "<result><x/></result>",
      "<result><job><id>a</id><title>T</title></job>",
    ])
      await expect(drain(jobvite.list(src, textCtx(body).ctx))).rejects.toThrow(SchemaError);
  });
  it("rejects malformed keys", () => {
    expect(() => platformFor(source("jobvite", "../x"))).toThrow(/Invalid/);
  });
});
