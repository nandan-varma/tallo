# Fetching Oracle Cloud HCM and SmartRecruiters with fewer requests

Research for issue #88 (Oracle Cloud HCM primary, SmartRecruiters secondary). No production code was changed.
Measured on 2026-11-20/21 against the live boards in `sources/`, sequentially (1 in flight, 250 ms gap, a second
polite stream on a different host at most), honoring `Retry-After`. No 429/503 was seen. Roughly 560 requests were
spent in total (about 230 Oracle, 330 SmartRecruiters).

## Summary

- On both platforms the detail call is about 99% of requests in a first sync or after a `version` bump, and neither
  list endpoint returns the full description, so the call cannot be skipped by any query flag. Cheaper listing alone
  saves 1% to 2% of requests.
- The big recurring saving is process, not protocol: a `map`-only change forces a re-fetch of every posting
  (`platform.version` is part of the hash in `packages/collect/src/engine.ts`), although the raw pack already holds
  `{listing, detail}` for every posting. Re-mapping from stored raw payloads costs 0 requests.
- Oracle: `limit=200` is accepted (server cap 200) and halves list requests; `sortBy=POSTING_DATES_DESC` gives a
  stable order; the 10k cap can be partitioned with `jobFamilyId` / `locationId`; `facetsList=NONE` cuts list bytes 13%.
- SmartRecruiters: honors `ETag`/`If-None-Match` (304, 0 bytes) on list pages and detail; `releasedAfter` works;
  page size is capped at 100; `jobAdId` is unique per posting, so details cannot be shared.

## Current cost model

| Platform | Postings | List requests (now) | Detail requests, first sync or version bump | Steady state |
| --- | --- | --- | --- | --- |
| Oracle (7 boards) | 17,563 (JPM 6,885; Hilton 4,394; Oracle 2,879; Honeywell 1,371; Fortinet 1,089; Nokia 548; Molina 397) | 177 per run (limit 100) | 17,563 | 177 + changed |
| SmartRecruiters (293 boards) | 86,345 (Dominos 25,136; CROSSMARK 21,158; AECOM 5,591; Bosch 5,181; 5 more over 1,000) | 1,113 per run | 86,345 | 1,113 + changed |

The listing fingerprint is stable: three crawls of the JPM listing produced identical fingerprints for unchanged rows
(rows differing between the 4-minute crawls were postings edited meanwhile, about 0.4%). So steady state already skips
unchanged details; the hog is first ingestion and re-fetch after a version bump.

## Oracle Cloud HCM findings

Endpoint: `/hcmRestApi/resources/latest/recruitingCEJobRequisitions?finder=findReqs;siteNumber=...,limit=,offset=`.

| Idea | Result | Verdict |
| --- | --- | --- |
| Descriptions in the list via `expand` (`all`, `requisitionList`, `...requisitionFlexFields`) | List rows only ever carry `ShortDescriptionStr` (a one-sentence teaser) plus `ExternalQualificationsStr`/`ExternalResponsibilitiesStr`, which are null on JPM. `ExternalDescriptionStr` exists only on `recruitingCEJobRequisitionDetails` (confirmed with `describe`) | Detail cannot be skipped |
| Dates in the list | `PostedDate` is already in the list; the detail adds `ExternalPostedStartDate` (full timestamp) | Already free |
| `fields=` | 400 "not valid" | Unsupported |
| Larger page: `limit=200/500/1000` | 200 rows returned for any limit above 200 (server clamps to 200). Full JPM crawl: 69 requests (limit 100) to 35 (limit 200), 1.27 MB to 1.08 MB, all 6,884 rows unique, no short pages beyond the 1 row posted mid-crawl | Adopt: halves list requests |
| `facetsList=NONE` | Removes the nine facet arrays: 16.8 KB to 12.8 KB per 100-row page (-24%); full JPM crawl at 200: 1.08 MB to 0.94 MB (-13%). The default `facetsList=` (empty) or `Facets=` change nothing | Cheap bytes win. Also confirm no code reads facets (none does) |
| `sortBy=POSTING_DATES_DESC` | Works, newest first. Offset paging is then stable while jobs are posted (a new job lands at the front, so a one-row shift is the only risk); relevancy order gave 25 differing rows over a 4-minute crawl, date order gave 0 | Adopt for stability; also enables early stop (below) |
| Date filter | `selectedPostingDatesFacet=7` (1,242 rows on JPM, the "less than 7 days" facet) and `postingStartDate=YYYY-MM-DD`, `postingEndDate` work inside the finder (`postingStartDate=2026-11-14` gave 1,244). Upper-case spellings are rejected | Usable for incremental discovery, see plan item 4 |
| Partitioning past the 10k cap | `jobFamilyId=<categoriesFacet.Id>` (1,003 = facet count) and `locationId=<locationsFacet.Id>` (5,136) filter; date windows too (`postingStartDate`+`postingEndDate`: 526 rows). No board is above 10k today (largest 6,885), so the cap is not hit | Solves the cap when needed; no urgency |
| Detail without `expand=all` | `onlyData=true`: 3,475 B on the wire vs 4,071 B (-15%), description identical (3,536 chars). Path form `/recruitingCEJobRequisitionDetails/{id}?onlyData=true` 3,305 B (-19%). `expand=secondaryLocations` only: 3,490 B | Small. `expand=all` adds `skills`, `requisitionFlexFields`, `workLocation`, `media`, `otherWorkLocations`, `links` that `map` ignores; dropping them narrows the raw payload (rule 1, lossless), so a deliberate call |
| Multi-id detail (`Id="a","b"`) | Returns 1 item | No batching |
| Conditional requests | No `ETag`/`Last-Modified`. List is `no-cache, no-store`; detail `Cache-Control: max-age=1800` only | No 304 savings |
| Sitemap, RSS, feeds | `robots.txt` and `sitemap.xml` are blocked by the WAF (403); the candidate-experience URLs return the same SPA shell | None exist |
| `describe` metadata | `/recruitingCEJobRequisitions/describe` lists every attribute and child; no hidden bulk or description attribute | Nothing hidden |
| Open source / docs | Oracle's REST docs list `findReqs` variables (`siteNumber`, `sortBy`, `correctedKeyword`, offset/limit); no public scraper found that does better | Nothing to borrow |

Detail latency is 0.3 s, so wall time is fine; the request count is what is expensive.

### Before and after (Oracle, 7 boards)

| Scenario | Before | After (limit 200 + facetsList=NONE) |
| --- | --- | --- |
| List requests per run | 177 | 90 (-87) |
| First sync / version bump | 177 + 17,563 = 17,740 | 90 + 17,563 = 17,653 (-0.5%) |
| JPM list bytes per run | 1.27 MB | 0.94 MB |
| Version bump with re-map from raw (plan item 1) | 17,740 | 90 |

## SmartRecruiters findings

| Idea | Result | Verdict |
| --- | --- | --- |
| Page size | `limit` above 100 is clamped to 100 (`limit` echoed 100 for 200 and 500) | Already at max |
| Description in the list | Absent; `jobAd`, `postingUrl`, `applyUrl` only on `/postings/{id}` | Detail cannot be skipped |
| Share details across postings | 500-row samples of Dominos and CROSSMARK and 300 of AECOM: `jobAdId` and `uuid` were unique for every row | No dedupe possible |
| `ETag` / `If-None-Match` | Weak ETag is stable across repeat calls and a conditional request returns 304 with 0 bytes, for list pages (9.7 KB body) and detail (3.9 KB). Requests still count | Bytes only |
| `releasedAfter` | Works (Canva: 6 of 32). `updatedAfter`, `language`, `destination` are ignored (32 of 32). `q` and `country` filter | Discovery of new postings only; edits are invisible |
| Sitemap/feeds | `jobs.smartrecruiters.com/sitemap.xml`, `/robots.txt`, per-company sitemap all 404; the careers page is an HTML app | None |
| Skewed boards | Dominos 25,136 and CROSSMARK 21,158 are 54% of all 86,345 postings (1,113 list pages in total, 464 of them these two) | A first sync of one of them is 21k to 25k requests |

## Ranked implementation plan

| # | Change | Saving | Risk | Effort | Freshness / completeness compromise |
| --- | --- | --- | --- | --- | --- |
| 1 | Re-map from stored raw packs when only `map` changes: split `version` into `collectVersion` (hash input) and `mapVersion` (re-map from `raw/<source>/<run>.ndjson.gz`). Applies to all platforms | Oracle 17.7k and SmartRecruiters 87k requests avoided on every mapper-only bump (vs 100% re-fetch today) | Medium: raw packs only hold changed postings per run, so a posting's latest raw part must be found; needs a remap command and index of latest pack per posting | Medium to large | None, if the raw payload has everything `map` reads (true while collectors stay lossless) |
| 2 | Oracle list: `limit=200`, `sortBy=POSTING_DATES_DESC`, `facetsList=NONE` in `finderUrl` (bump platform version) | -87 list requests per run (-49% of list) and -25% list bytes; stable order | Low | Small (one function plus tests with the existing fake Http) | None. Keep the short-page handling |
| 3 | Oracle detail: `onlyData=true` instead of `expand=all` (or the path form) | -15% to -19% detail bytes (about 0.6 KB x 17.5k = 10 MB on first sync); 0 requests | Low | Small | Drops unmapped child collections from the raw pack; decide whether that conflicts with rule 1 |
| 4 | Oracle early stop on date-sorted listing is NOT safe for closure (needs a full complete listing). Option: full listing every N days, between them list only `postingStartDate=<last full - 1 day>` to find new postings | Cuts list pages between full runs by about 80% on large boards | Medium: closure and edited postings only update on the full run | Medium | Closure and edits up to N days late |
| 5 | SmartRecruiters: cache `ETag` per list page and per detail and send `If-None-Match` | Bytes only (about 30 KB per 100-row page); 0 requests saved | Medium: a store for ETags per page/posting and offset drift | Medium | None; low value, skip unless egress bytes matter |
| 6 | SmartRecruiters: `releasedAfter` incremental discovery between full runs | List pages for the two giant boards (464 of 1,113) drop between full runs | Medium | Medium | Edits and closures only on the full run |
| 7 | Cap partitioning with `jobFamilyId` / `locationId` for boards that pass 10k | Completeness for a future large Oracle board; no saving now | Low | Small | None |

Decision: do 1 (largest, cross-platform) and 2 (trivial) first; 3 is a policy call. Items 4 to 6 trade freshness for
list requests that are already about 1% of the total, so they are not worth doing before 1.

## Not worth pursuing

- A bulk or batch detail endpoint, in either platform (multi-id returns one item; none exists on SmartRecruiters).
- Sitemaps and feeds for either platform (blocked or absent).
- Larger `limit` on SmartRecruiters (clamped at 100).
- Conditional requests for Oracle (no validators).

## Reproducing

Probe scripts were throwaway Python (urllib, sequential, 250 ms sleep). The key calls:

```
GET https://<host>/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=<site>,limit=200,offset=0,sortBy=POSTING_DATES_DESC,facetsList=NONE
GET https://<host>/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails/<id>?onlyData=true
GET https://api.smartrecruiters.com/v1/companies/<key>/postings?limit=100&releasedAfter=<ISO>
GET https://api.smartrecruiters.com/v1/companies/<key>/postings/<id>   (If-None-Match: <etag> returns 304)
```
