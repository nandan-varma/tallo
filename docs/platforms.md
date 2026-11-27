# Platform status

Tracked in git on purpose (not in the database). Update when a platform or its sources change.
Source counts: `pnpm --filter @tallo/runner tallo sources`.

Tiers by value (share of jobs in the legacy dataset): Tier 1 = Greenhouse, Lever, Ashby, SmartRecruiters
(99% of configured boards); Tier 2 = Workday (large employers, hard pagination); Tier 3 = custom company
sites and long-tail ATS.

| Platform                                          | Tier | Status                                                       | Detail call                             | Notes                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | ---- | ------------------------------------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| greenhouse                                        | 1    | shipped, live-verified                                       | no (pay ranges in the listing)          | EU host via `params.region`                                                                                                                                                                                                                                                                                                         |
| lever                                             | 1    | shipped, live-verified                                       | no                                      | `salaryRange` mapped when present; unknown board is 404, so an empty list is authoritative                                                                                                                                                                                                                                          |
| ashby                                             | 1    | shipped, live-verified                                       | no                                      | pay components from `compensation`                                                                                                                                                                                                                                                                                                  |
| smartrecruiters                                   | 1    | shipped, live-verified                                       | yes (job ad)                            | unknown company answers 200 empty                                                                                                                                                                                                                                                                                                   |
| workday                                           | 2    | shipped, live-verified on 6 tenants                          | yes (description)                       | 2,000-result cap handled by facet splitting; unsplittable slices and premature short pages report incomplete                                                                                                                                                                                                                        |
| oraclecloud                                       | 3    | shipped, live-verified on 8 boards                           | yes (description, dates)                | `siteNumber` (+`sitePath`), `defaultSite: true` on host default; 10k cap, see below                                                                                                                                                                                                                                                 |
| personio                                          | 3    | shipped, live-verified on 25 boards                          | only for postings lacking a description | one XML feed per board; `salaryInformation` and `yearsOfExperience` bands mapped; empty feed is not authoritative                                                                                                                                                                                                                   |
| eightfold, icims                                  | 3    | todo                                                         |                                         |                                                                                                                                                                                                                                                                                                                                     |
| recruitee                                         | 3    | shipped, live-verified on 23 boards                          | no (list has description)               | one GET `<key>.recruitee.com/api/offers/` per board; unknown board is 404, so an empty 200 is authoritative; pay from `salary` (string amounts, stated `period`); remote+hybrid both flagged leaves `workMode` unset; experience/education codes are categories, kept in `extras`; application form (`open_questions`) stays in raw |
| amazon, apple, google, microsoft, meta, uber, ... | 3    | amazon, apple, google, meta, microsoft shipped; uber skipped |                                         | one adapter per company site; browser-walled sites need a managed browser                                                                                                                                                                                                                                                           |

| workable | 3 | shipped, live-verified on 14 boards | no (widget has the text) | one request per board (`/api/v1/widget/accounts/<key>?details=true`), no paging, no pay fields; empty list is not authoritative (live accounts with nothing open answer 200 `[]`, unknown ones 404); heavy hosts answer 429 after ~60 quick probes, so keep it gentle; job-level `city`/`state`/`country` fill in when every `locations[]` entry is blank |
| teamtailor | 3 | shipped, live-verified on 23 boards | no (RSS has the description) | one RSS feed per board, `<key>.teamtailor.com/jobs.rss`; 100 items per answer, paged by `offset` |
| bamboohr | 3 | shipped, live-verified on 28 boards | yes (description, date) | `<key>.bamboohr.com/careers/list` + `/{id}/detail`; unknown tenant 302s (error), empty board is authoritative; pay is free text so kept in `extras.compensationText`, untyped |
| icims | 3 | shipped, 25 seeded boards | yes for portals; no for Jibe | Portal HTML and JSON-LD; six explicit Jibe hosts. Empty listings are not authoritative. |
| jobvite | 3 | shipped, 26 seeded boards | no | Public XML feed, full descriptions; shared host limited to one request per 3 seconds. Empty feeds are not authoritative. |
| rippling | 3 | shipped, live-verified on 66 boards | yes (description, pay bands) | `ats.rippling.com/api/v2/board/<key>/jobs` paged by 100 (location, department, work mode) + `/api/v1/board/<key>/jobs/<id>`; unknown board is 404 so empty is authoritative; complete only when every `totalItems` posting was seen |
| gem | 3 | shipped, live-verified on 37 boards | no (list has description) | one GET `api.gem.com/job_board/v0/<key>/job_posts/`; unknown board is 404, empty is authoritative; no pay field; a key may start with `-` |
| pinpoint | 3 | shipped, live-verified on 23 boards | no (list has the ad) | one GET `<key>.pinpointhq.com/postings.json` (not paged: 281 postings in one answer); structured pay when `compensation_visible`; unknown tenant is 404 |
| bestbuy | 1 | shipped, dry-run verified (5 postings) | yes (portal page JSON: description, pay) | `jobs.bestbuy.com/bby`, a client-rendered ServiceNow portal; robots allows everything. Listing is the sitemap `bestbuy.service-now.com/api/93622/seo/sitemap` (1,424 job URLs, `lastmod` kept in the listing). Detail is `GET /api/now/sp/page?id=job_details&req_id=<id>` (anonymous, ~290 KB of which only `data.job` is kept); an empty `job` is a gone posting. Pay comes from `pay_min`/`pay_max`/`pay_currency` when above zero, hourly only when the source's own `pay_range` label ends in `/hr`. The portal's search widget needs a session cookie and token that `Http` cannot carry, so it is not used. Apply link is the employer's BrassRing page. About 1,424 pages, so `egress: local`. |
| breezy | 3 | shipped, live-verified on 5 boards | only when the feed row states a salary (job page JSON-LD) | `<key>.breezy.hr/json?verbose=true` feed includes the description (plain `/json` does not); detail fetches the job page only for structured pay (`baseSalary`); unknown portal is 404. Not shipped: Comeet (per-company token), Eightfold (tenants answer 403 "Not authorized for PCSX", Netflix only), JazzHR/Join/Homerun/Paylocity (HTML or session only, no public JSON) |
| microsoft | 4 | shipped, live-verified | yes (description, `position_details`) | Eightfold PCSX at `apply.careers.microsoft.com`. The listing is the site's own `/careers/sitemap.xml` (robots.txt allows `/careers`): one request for every posting (about 2,300) with its `lastmod`, which is the change marker. One `search` call reads the reported total, so a sitemap that is missing postings is an incomplete listing. `search` is the endpoint the site throttles hard (plain-text 429 "Please try again later", no Retry-After); `position_details` took 70 sequential requests at up to 4 a second without one. The board stays `egress: local`. A first sync is one list request plus one detail call per posting. |
| fedex | 1 | shipped, dry-run verified (5 postings) | yes (job page JSON-LD + apply link) | `careers.fedex.com` (robots allows everything, no public list API). The listing is the two canonical English sitemaps, a reviewed fixed set: `sitemap-a0a4453b-en.xml` (US and Canada, 2,980 postings) and `sitemap-c84076ce-en.xml` (rest of the world, 1,538); the other locale sitemaps repeat the same postings (checked on fr-ca, de-de, pt-br), so they are not read. Detail is the job page `JobPosting` JSON-LD (read from the raw script body, which carries `&quot;` entities) and `a.apply-button`, the employer's Paradox or Workday application. The sitemap `lastmod` equals the posting date and is dropped, so a changed posting is not re-fetched until `version` is bumped. A 404 page is a gone posting. About 4,500 pages of ~150 KB, so `egress: local`. Pay is not stated in the JSON-LD. |
| phenom | 1 | shipped, dry-run verified (5 postings) | yes (job page JSON-LD, description only) | Phenom career sites; today `www.jobs-ups.com` (UPS), key = host, `params.path` (default `us/en`) and `params.lang` (default `en_us`). Listing is `POST /widgets` (`refineSearch`, 100 rows per page, `totalHits` 4,255 for US English), the call the site's search page makes; robots.txt allows it. The listing row carries the apply link, category, `openingPayRate` text (kept in extras, not parsed), locations and posted date. Detail is the job page JSON-LD only: the page also embeds the full requisition record, which contains internal HR fields naming people, so it is never read or stored. 410 is a gone posting. `ml_*` fields and `badge` are dropped from the fingerprint. About 4,255 job pages of ~85 KB, so `egress: local`. |
| successfactors | 1 | shipped, live-verified on 4 sites (3-4 postings each) | yes (job page microdata: title, description, location, posted date, labelled fields) | SAP SuccessFactors Career Site Builder sites (JetBlue, NextEra, ExxonMobil, John Deere; key = site host from a reviewed list in the platform). robots.txt disallows only apply, talent-community and service paths. Listing is the site's `/sitemap.xml` (an urlset, or an RSS feed on ExxonMobil and Deere); the job page carries schema.org `JobPosting` microdata plus `data-careersite-propertyid` fields (department, facility). A closed or missing page is `PostingGone`. Not added: American Airlines (sitemap answers 403) and Wipro (job pages answer 403). |
| starbucks | 4 | shipped, live-verified (5 postings) | yes (description, `position_details`) | Eightfold PCSX at `apply.starbucks.com`, the same code as `microsoft` (shared `eightfold` factory). The listing is `/careers/sitemap.xml` (about 21,900 postings, one 6 MB request) with each posting's `lastmod`, plus one `search` call for the reported total; this replaces about 2,200 throttled `search` pages. A first sync is one list request plus one detail call per posting (about 22,000); later syncs fetch only postings whose `lastmod` moved. Pay is stated as text only (`extras.payRange*`), kept as written; no employment type is stated. |
| ibm | 3 | shipped, live-verified | no (index rows carry the full body) | `POST www-api.ibm.com/search/api/v2` (the careers search index, 100 a page, `from` capped at 10,000), sorted by `dcdate` then `_id`; 5,762 postings / 58 requests measured. `careers.ibm.com` job pages answer a browser challenge (202, empty) and are only linked, never fetched. `_source` is a field whitelist, mapped fields are listed in `src/ibm`. |
| walmart | 3 | shipped, live-verified | yes (job page `__NEXT_DATA__`) | careers.walmart.com (Walmart, Sam's Club, Global Tech; not on Workday). robots.txt disallows `/api` and `/results`, so the search API is NOT used: `sitemap.xml` (1 request, 15,323 posting ids measured, no dates) plus one ~30 KB page `/us/en/jobs/R-<id>` per new posting (first sync about 15,300 requests at one a time, the sweep starting at a 700 ms gap and probing down to 250 ms; about 7% of sitemap ids answer 307 to job-not-found; those are reported as `gone` postings, dropped from the listing instead of failing the run, so the board can still finish and they close by the normal absence rule). `recruitingStartDate`, `createdAt` and non-empty `shifts` go to extras. The listing carries only ids, so a changed posting is not re-fetched until `version` is bumped. `egress: local`. |
| radancy | 1 | shipped, live-verified on 2 boards | yes (job page JSON-LD + apply link) | Radancy TalentBrew sites (`www.att.jobs`, `jobs.walgreens.com`; key = host). `/search-jobs/` is disallowed by robots.txt, so the listing is `sitemap.xml` (`/job/<city>/<slug>/<org>/<id>`, ids only; its `lastmod` is the build time and is dropped) and the detail is the job page (`JobPosting` JSON-LD, `a.job-apply[data-apply-url]` is the employer's own application). A sitemap is capped at 500 postings and has no index, partitions or paging (Walgreens: `?p=2` is ignored), so a site over the cap uses `params.searchPath` (`/en/search-jobs/results`, TalentBrew's JSON results endpoint; Walgreens' robots.txt allows it, AT&T's does not): 100 ids per request, 100 pages per query (10,000), so a site over that is split by facet (country, then state, from the filter list of one 5 MB response; `FacetFilters[0].ID/FacetType/IsApplied`). The union is `complete` only when it reaches the site's own `data-total-results`, so a posting with no country or a mid-listing change makes it incomplete rather than closing anything. Walgreens measured live: 22,363 listed, complete, about 240 requests. Counts are per query (a posting in two states is deduplicated). AT&T (2,166 postings) answers headers over Node's 16 KB default, so it is `egress: local` and the runner script sets `--max-http-header-size`. Pay is empty in both JSON-LDs (stated in text only). Kroger is not Radancy (it is on Oracle Cloud). |
| goldman | 3 | shipped, live-verified | no (list has description HTML and pay band) | `POST api-higher.gs.com/gateway/api/v1/graphql` `roleSearch` (the public gateway behind higher.gs.com, 250 a page); 933 roles / 4 requests measured. `higher.gs.com` robots.txt allows only `/roles/`; the gateway host publishes no robots.txt. Pay bands carry no interval, so it stays `unknown`. `createdDate` is deliberately unmapped: it is the gateway's refresh time, not a fact about the role (the fingerprint drops it). |
| google | 3 | shipped, live-verified | no (results page has full descriptions) | Public results page's `AF_initDataCallback` `ds:1` payload, 20 postings a page; 3,015 postings / 151 pages measured 2026-11-21. Positional records (no field names); description, responsibilities and qualifications inline; no structured pay or work mode. Total changes or repeated pages report incomplete. `postedAt` reads slot 14 because Google's own `sort_by=date` orders by it: over 45 consecutive pairs slot 14 never ascends, while slot 12 does (13 of 59) and slot 13 does twice (#142, 2026-11-22). Slots 12/13/14 are all `[unix seconds, nanos]`; 14 is 13 plus about 1 s; slot 12 is earlier than 13 for about a fifth of postings (618 of 3,015) and never later, and across two full runs 23 h apart no slot changed in any posting. Slot 12 is left unmapped: no source says what it means. |
| apple | 3 | shipped, live-verified | yes (description, qualifications, Pay & Benefits prose) | `POST /api/v1/search` (20 a page) + `GET /api/v1/jobDetails/<id>`; 6,474 postings / 324 pages measured 2026-11-21. Detail is one request per changed posting; no typed pay band (Pay & Benefits is prose in a footer). Total changes or repeated pages report incomplete. The search row of a `PIPE-` posting states `postDateInGMT` as the request time (changes every call), so the fingerprint drops it; otherwise every run refetched every such detail (#137). |
| meta | 3 | shipped, live-verified | yes (job page JSON-LD + preloaded detail) | Anonymous Relay search (one response, the site paginates in the browser) plus the public job page; `params.teams` is the site's structured team filter and needs a distinct source key. No department, pay, work mode or dates are parsed from text. Robot notice on the host asks for written permission before automated collection; collect gently. |

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

A slice that reports the cap is split by facet right after its first page; its other 99 pages would only repeat
what the children list. The parent is paged in full only when the children cover fewer than 2,000 rows. Measured
on Citi (wd5): 791 requests before, 692 after, the same 4,207 postings (identical id sets), complete. The facet is
still the one with the most coverage; a cheaper facet was not adopted because nothing proves it covers the board.
Tenants that state `remoteType` ("Remote", "Hybrid", "On-Site", "In Office") could have it read as work mode, but that
bumps the version and re-fetches every Workday detail, so it is left as an optional follow-up.

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

Oracle Cloud (`params.siteNumber`): hosts are `*.fa.oraclecloud.com`, `*.fa.us2.oraclecloud.com` and `*.fa.ocs.oraclecloud.com`, plus the one custom host `enterpriseplatform.dell.com` (Dell; `jobs.dell.com` sends candidates there; list `CX_1001`, site `careers`, 589 requisitions measured).
An unknown siteNumber silently returns the host's default board, so `list()` probes a site that cannot exist and
refuses a site whose first requisition Id or total matches the probe, unless the source says `params.defaultSite: true`.
The seven seeds that carry it are the host default. Tenet (`eodr`, CX_1001) is not seeded: its first Id matches the
host default, so it is refused, and it is a distinct board (different total, 94 of the first 100 Ids shared), so the
acknowledgement would be false. Listing stops at 10,000 results and reports incomplete.

The finder is read 200 rows a page (it clamps a larger `limit` to 200; checked live with 500), newest first
(`sortBy=POSTING_DATES_DESC`, so offsets stay stable while postings arrive) and without facet arrays
(`facetsList=NONE`; nothing reads them). Across the seven boards that is 90 list requests a run instead of 177.
Two boards (eeho, edel) still end with one short page: the finder reports 2 rows more than it returns.
Measured on eeho (CX_45001, 2,870 reported): newest-first, oldest-first and relevancy order each return the same
2,868 distinct Ids, so the two missing rows are counted but never served; no query shape reaches them. It is an
accepted limit: those boards stay `complete: false` and never close postings.

Oracle boards over 10,000 postings (Dollar General, `ibxwjb`, CX_1: 91,323) cannot be listed completely. The finder
does accept facet selection (`selectedLocationsFacet=<id>`, `selectedCategoriesFacet=<id;id>`, totals shrink as
expected), but each facet list is cut to its ten largest entries (ten states, ten cities within a state), so the
remaining states and categories cannot be enumerated from the API and the ten that show cover only part of a
board (Key Carrier alone is 63,844 and splits only by location). Listing stays at the first 10,000 newest and
reports incomplete; postings beyond it are never seen and nothing closes. Revisit only if a source for the full facet
ids appears (a hand-kept location id list per board was judged not worth it).

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

## Field mappings from the 2026-11-21 audit (#138)

Structured fields the sources state that the mappers now read. Every platform whose `map` output changed bumped its
`version`, so the next sync re-maps its postings. Nothing here is parsed from text.

| Platform    | Version | Now read                                                                                                                                                                        | Deliberately left                                                                                                                          |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| greenhouse  | 3       | Board `metadata` "Location Type" as work mode, after "Workplace Type" and "Work Type". `requisition_id` "See Opening ID" (placeholder on some Stripe jobs) is stored as absent. |                                                                                                                                            |
| lever       | 3       | `country` hints the primary location only; later places stay without a country.                                                                                                 |                                                                                                                                            |
| oraclecloud | 3       | `workLocation[0].TownOrCity` as the primary city.                                                                                                                               | `Region1`/`Region2` (district names and codes such as "0200", not ISO regions).                                                            |
| icims       | 4       | Each JSON-LD `jobLocation[].address` when a posting lists several, with its own city, region and country. `Category` header field, else `occupationalCategory`, as department.  | `occupationalCategory` is an occupation class, not a department; it is used only where the page has no Category field, as the issue asked. |
| workday     | 4       | `jobRequisitionLocation.country.alpha2Code` as the primary location's country code; the posting's country name is the fallback.                                                 | `remoteType` stays in extras until a live board shows its values (the API was in maintenance during the audit).                            |
| apple       | 2       | `standardWeeklyHours` from the search row when the detail does not state it (13 of 20 rows).                                                                                    |                                                                                                                                            |

Shared work-mode reader (`kit.ts`, `workModeOf`): a mode is read only when the source's words name exactly one mode
family (hybrid, remote or onsite) and nothing negates it ("non", "not", "no"). "Hybrid (Travel-Required)" reads as
hybrid. "Remote or On-Site", "Hybrid Remote" and "Non-Remote" read as unknown, because the source does not state one
mode. Among the values seen in fixtures or the audit, only Greenhouse output changes under this rule, so jobvite and amazon keep their versions.

Not done, on purpose: SmartRecruiters `false`/`false` as onsite (ambiguous with "Flexible"); BambooHR `locationType`
codes (unverified); pay parsed from prose; country or city derived from text-only sources.

## Platform simplification audit

- Greenhouse: `?content=true&pay_transparency=true` on the board listing already returns `pay_input_ranges` for
  every posting (checked on Anthropic, Airbnb, Databricks, Figma: identical to the single-job answer). The
  per-posting detail call is gone: one request per board instead of one plus one per changed posting. The
  application `questions`, `compliance` and `demographic_questions` that only the detail carried are not kept.
- SmartRecruiters (3): `unpublishOn` (the scheduled unpublish date) is the posting's `expiresAt`.
- Uber: the careers search RPC (`/api/loadSearchJobsResults`) sits under `uber.com/api/`, which robots.txt disallows (`disallow: */api/`), and the careers pages answer 406 to a plain client. Not read.
