# Platform status

Tracked in git on purpose (not in the database). Update when a platform or its sources change.
Source counts: `pnpm --filter @tallo/runner tallo sources`.

Tiers by value (share of jobs in the legacy dataset): Tier 1 = Greenhouse, Lever, Ashby, SmartRecruiters
(99% of configured boards); Tier 2 = Workday (large employers, hard pagination); Tier 3 = custom company
sites and long-tail ATS.

| Platform                                          | Tier | Status                              | Detail call                             | Notes                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | ---- | ----------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| greenhouse                                        | 1    | shipped, live-verified              | yes (pay ranges, questions)             | EU host via `params.region`                                                                                                                                                                                                                                                                                                         |
| lever                                             | 1    | shipped, live-verified              | no                                      | `salaryRange` mapped when present; empty list is not authoritative                                                                                                                                                                                                                                                                  |
| ashby                                             | 1    | shipped, live-verified              | no                                      | pay components from `compensation`                                                                                                                                                                                                                                                                                                  |
| smartrecruiters                                   | 1    | shipped, live-verified              | yes (job ad)                            | unknown company answers 200 empty                                                                                                                                                                                                                                                                                                   |
| workday                                           | 2    | shipped, live-verified on 6 tenants | yes (description)                       | 2,000-result cap handled by facet splitting; unsplittable slices and premature short pages report incomplete                                                                                                                                                                                                                        |
| oraclecloud                                       | 3    | shipped, live-verified on 7 boards  | yes (description, dates)                | `siteNumber` (+`sitePath`), `defaultSite: true` on host default; 10k cap, see below                                                                                                                                                                                                                                                 |
| personio                                          | 3    | shipped, live-verified on 25 boards | only for postings lacking a description | one XML feed per board; `salaryInformation` and `yearsOfExperience` bands mapped; empty feed is not authoritative                                                                                                                                                                                                                   |
| eightfold, icims                                  | 3    | todo                                |                                         |                                                                                                                                                                                                                                                                                                                                     |
| recruitee                                         | 3    | shipped, live-verified on 23 boards | no (list has description)               | one GET `<key>.recruitee.com/api/offers/` per board; unknown board is 404, so an empty 200 is authoritative; pay from `salary` (string amounts, stated `period`); remote+hybrid both flagged leaves `workMode` unset; experience/education codes are categories, kept in `extras`; application form (`open_questions`) stays in raw |
| gem, rippling                                     | 3    | todo                                |                                         | candidates once sources are found                                                                                                                                                                                                                                                                                                   |
| amazon, apple, google, microsoft, meta, uber, ... | 3    | todo                                |                                         | one adapter per company site; browser-walled sites need a managed browser                                                                                                                                                                                                                                                           |

| workable | 3 | shipped, live-verified on 14 boards | no (widget has the text) | one request per board (`/api/v1/widget/accounts/<key>?details=true`), no paging, no pay fields; empty list is not authoritative (live accounts with nothing open answer 200 `[]`, unknown ones 404); heavy hosts answer 429 after ~60 quick probes, so keep it gentle |
| teamtailor | 3 | shipped, live-verified on 34 boards | no (RSS has the description) | one RSS feed per board, `<key>.teamtailor.com/jobs.rss`; 100 items per answer, paged by `offset` |
| bamboohr | 3 | shipped, live-verified on 28 boards | yes (description, date) | `<key>.bamboohr.com/careers/list` + `/{id}/detail`; unknown tenant 302s (error), empty board is authoritative; pay is free text so kept in `extras.compensationText`, untyped |
| icims | 3 | shipped, 25 seeded boards | yes for portals; no for Jibe | Portal HTML and JSON-LD; six explicit Jibe hosts. Empty listings are not authoritative. |
| jobvite | 3 | shipped, 26 seeded boards | no | Public XML feed, full descriptions; shared host limited to one request per 3 seconds. Empty feeds are not authoritative. |

## Conditional listing (ETag)

A platform whose whole-board listing is one response may send the stored `ETag` as `If-None-Match` and
treat 304 as "unchanged since the last complete, fully applied run" (`Listing.notModified`). The run then
costs one request: no diff, no details, no uploads, and it never closes, ages or reopens a job. Probed live
(November 2026, one board each, 3 s apart, `GET`/`POST` the same call the collector makes):

| Platform        | ETag sent    | If-None-Match | Enabled | Why                                                             |
| --------------- | ------------ | ------------- | ------- | --------------------------------------------------------------- |
| greenhouse      | weak, stable | 304           | yes     | stripe `?content=true`: 6.1 MB -> 0 B                           |
| ashby           | weak, stable | 304           | yes     | 1password: 2.3 MB -> 0 B (`max-age=60`)                         |
| lever           | weak, stable | 200 (full)    | no      | palantir: the tag is sent but never honored; no `Last-Modified` |
| smartrecruiters | weak, stable | 200 (full)    | no      | AbbVie page 1: not honored; the listing is also paginated       |
| oraclecloud     | none         | n/a           | no      | `no-store`; paginated                                           |
| workday         | none         | n/a           | no      | `no-store`; POST, paginated, facet-split                        |

No probed host sent `Last-Modified`. The stored validator is versioned with the platform `version` and the
catalog `PREPARE_VERSION`, so a `map` change is never skipped. It is kept only after a complete listing with
every posting applied and no job on a first absence; any other run clears it.

Workday requires a nonnegative integer `total` on every page. It keeps the highest reported total
if a board changes while paging, and marks the listing incomplete when the final count of postings
(unique ones plus rows without an `externalPath`) falls short. Facet coverage or duplicate pages
cannot establish completeness from page length alone; incomplete listings never apply job closure.

Live behaviour (checked with curl and `tallo verify`, November 2026):
- `limit` is capped at 20: 21, 50, 100, 200 and 2000 all return HTTP 400. `offset` is honoured only up to 2000 on
  capped boards: from offset 2000 on they return the first page again and report `total` 2000 (Citi, Accenture,
  T-Mobile, ABB). PwC pages past 2000 with its real total (3,762). `total` is reported on every page on some
  boards and as 0 on later pages of others, so only the highest value is kept.
- A row with no `externalPath` (Accenture has one with only `bulletFields`) has no id and no detail URL. It cannot
  have a catalog row, so skipping it cannot close anything. It is reported once (`schema`, non-blocking) and
  counted toward `total`; it does not make the listing incomplete.
- HTTP 422 on the first request means the tenant is not served on that `params.wd` host (unknown tenant, or
  the wrong host: `zelis` is on `wd115`, not `wd1`). A valid tenant with a wrong site answers 404 `S21`
  ("Job_Posting_Site_ID"), which the engine already treats as a dead board. Hosts that are unknown to DNS
  answer nothing. `osv-amerisure/Amerisure` answers 422 on every Workday host we probed (wd1-wd30, wd100-wd120,
  wd501-wd503): the tenant is not discoverable from here; leave it until its site is known.
- HTTP 403 `S22` "permission denied" on the first request means the site exists but refuses the public listing
  (`wmeimg/160over90US`: the tenant's DRS outage page names the same site). The run fails with a readable
  message; closure never applies.
- A 422 or 403 on the first request is a failed run, not a dead board: the engine marks a board dead only on a
  first-request 404 or redirect. Making a 422 count as dead needs a change in `packages/collect` (not part of
  this platform change); the platform does not fake a 404.

## Per-platform field coverage (what maps today)

All: title, apply/job URL, description text, locations (as the source names them, with country/region/city only when the
source gives those fields), work mode, department, employment type, posted/updated dates, requisition id when present,
pay when structured (in the source's own interval), source extras. Nothing is inferred from text.

Personio (`https://<key>.jobs.personio.de/xml`, the `.de` host serves `.com` boards too): the feed is XML, parsed
with fast-xml-parser, and answers in the board's default language. A position with no description in that language has
an empty `jobDescriptions`; `detail` then reads `?language=en` (once per run and board) and takes the description from
there. An unknown board answers 404; a 200 with no positions may be a board whose feed is off, so empty is not
authoritative. `salaryInformation.type` maps yearly/monthly/weekly/daily/hourly, anything else is `unknown`.
Seniority, schedule, occupation and keywords go to extras. Boards whose postings have no description in any language
(e.g. hyntelo) are not seeded. No fingerprint: the feed has no volatile fields.

Oracle Cloud (`params.siteNumber`): hosts are `*.fa.oraclecloud.com`, `*.fa.us2.oraclecloud.com` and `*.fa.ocs.oraclecloud.com`.
An unknown siteNumber silently returns the host's default board, so `list()` probes a site that cannot exist and
refuses a site whose first requisition Id or total matches the probe, unless the source says `params.defaultSite: true`.
The seven seeds that carry it are the host default. Tenet (`eodr`, CX_1001) is not seeded: its first Id matches the
host default, so it is refused, and it is a distinct board (different total, 94 of the first 100 Ids shared), so the
acknowledgement would be false. Listing stops at 10,000 results and reports incomplete.

Oracle short pages before the reported total are recorded as incomplete, but collection continues
through later offsets up to the 10,000-result cap. This retains later postings without treating
the missing rows as proof that jobs closed.

Teamtailor (`key` = the `<key>.teamtailor.com` subdomain): `GET /jobs.rss` returns every open job with its description in
one request, so there is no detail call and no fingerprint (no field in the feed is volatile). One answer holds at most
100 items (a 112-job board answers 100; `?offset=100` returns the other 12), so a full answer is followed by the next
`offset`; a short answer is the end. A full answer that adds nothing new reports `complete: false`. An unknown subdomain
answers 404 (a dead board); a real board with no jobs answers 200 with an empty channel, which is authoritative. Boards on
a custom domain (`gofore.teamtailor.com` answers 301 to its own site) are not reachable through the allowlist and are not
seeded. Mapped: title, link, description, locations (`tt:city` + `tt:country`; the country code comes from the
catalog's own country table), `remoteStatus` (`fully` is remote, `hybrid`, `onsite`; `none` is unknown),
`tt:department`, `pubDate`, extras `role`, `division`, `companyName`, `companyUuid`. Left in raw only: `guid` (it is the
posting id), `tt:name` (the office label), `tt:address`, `tt:zip` (no typed home). The feed carries no pay, apply URL,
employment type or experience. Stena had one posting with no `tt:location` (warning, kept).

## Collector audit, 2026-11-20

- iCIMS v3 retains the original card and detail HTML in compressed raw evidence, outside D1. Fingerprints
  include unknown markup changes and normalize only relative Posted Date display text when an absolute
  title is present. Repeated portal/Jibe IDs and exhausted posting budgets fail rather than declaring a
  complete listing. Jibe keeps the largest reported total across pages.
- Personio v2 preserves literal section-heading text. Personio and Teamtailor reject malformed/truncated
  XML before listing; every XML collector bounds total entity expansions to 100,000 per response.
- Teamtailor accepts the verified North American `<key>.na.teamtailor.com` hostname shape; arbitrary
  dotted keys remain invalid. `empower.na` was live-verified, not yet added as a source by this change.
- Stratified live probes covered portal/Jibe iCIMS, Personio, Teamtailor, Recruitee, Workable and BambooHR:
  nonempty descriptions and valid prepared wire facts on sampled postings. The two reported untitled
  Ashby records still return literal empty title strings from their upstream API; they are not mapper bugs.
