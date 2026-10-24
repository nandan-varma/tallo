# Platform status

Tracked in git on purpose (not in the database). Update when a platform or its sources change.
Source counts: `pnpm --filter @tallo/runner tallo sources`.

Tiers by value (share of jobs in the legacy dataset): Tier 1 = Greenhouse, Lever, Ashby, SmartRecruiters
(99% of configured boards); Tier 2 = Workday (large employers, hard pagination); Tier 3 = custom company
sites and long-tail ATS.

| Platform                                          | Tier | Status                               | Detail call                 | Notes                                                                                                        |
| ------------------------------------------------- | ---- | ------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| greenhouse                                        | 1    | shipped, live-verified               | yes (pay ranges, questions) | EU host via `params.region`                                                                                  |
| lever                                             | 1    | shipped, live-verified               | no                          | `salaryRange` mapped when present; empty list is not authoritative                                           |
| ashby                                             | 1    | shipped, live-verified               | no                          | pay components from `compensation`                                                                           |
| smartrecruiters                                   | 1    | shipped, live-verified               | yes (job ad)                | unknown company answers 200 empty                                                                            |
| workday                                           | 2    | shipped, live-verified on one tenant | yes (description)           | 2,000-result cap handled by facet splitting; unsplittable slices and premature short pages report incomplete |
| oraclecloud                                       | 3    | shipped, live-verified on 7 boards   | yes (description, dates)    | `siteNumber` (+`sitePath`), `defaultSite: true` on host default; 10k cap, see below                          |
| eightfold, icims                                  | 3    | todo                                 |                             |                                                                                                              |
| workable, recruitee, gem, rippling                | 3    | todo                                 |                             | candidates once sources are found                                                                            |
| amazon, apple, google, microsoft, meta, uber, ... | 3    | todo                                 |                             | one adapter per company site; browser-walled sites need a managed browser                                    |

## Per-platform field coverage (what maps today)

All: title, apply/job URL, description text, locations (+country/state when parsable), work mode, department,
employment type, posted/updated dates, requisition id when present, pay when structured, source extras.
Experience years are inferred from description text for all platforms (`inferred: true`).

Oracle Cloud (`params.siteNumber`): hosts are `*.fa.oraclecloud.com`, `*.fa.us2.oraclecloud.com` and `*.fa.ocs.oraclecloud.com`.
An unknown siteNumber silently returns the host's default board, so `list()` probes a site that cannot exist and
refuses a site whose first requisition Id or total matches the probe, unless the source says `params.defaultSite: true`.
The seven seeds that carry it are the host default. Tenet (`eodr`, CX_1001) is not seeded: its first Id matches the
host default, so it is refused, and it is a distinct board (different total, 94 of the first 100 Ids shared), so the
acknowledgement would be false. Listing stops at 10,000 results and reports incomplete.
