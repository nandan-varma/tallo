# Fetching the expensive platforms

Research for #88, November 2026. Oracle Cloud HCM and SmartRecruiters measurements and the full ranked plan
are in [hog-fetching-oracle.md](hog-fetching-oracle.md). This document completes the Workday handoff.

## Workday measurements

The original serial survey requested the first listing page of all 392 configured boards with a 250 ms gap:
387 answered 200 with an integer total; 29 reported the 2,000-posting cap. The remaining successful boards
require 6,485 listing requests at 20 rows per page. These are listing requests only, before details.

| Board                         | Unique postings | Complete listing requests |
| ----------------------------- | --------------: | ------------------------: |
| NREL / NLR                    |              63 |                         4 |
| Adobe / external_experienced  |             253 |                        13 |
| Mastercard / CorporateCareers |             719 |                        36 |

These counts come from completed serial crawls. NVIDIA/Micron comparisons against an early-split prototype
were interrupted in the original session. A resumed comparison was stopped after ten minutes without a
completed result. No savings or completeness claim is made for that uncompleted experiment.

| Candidate             | Observation                                                                         | Consequence                                         |
| --------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------- |
| Larger pages          | NREL accepts 1 and 20; 21 and 100 return 400                                        | Keep 20                                             |
| GET listing / facets  | GET jobs returns 400; facets variants return 406                                    | No alternate feed found                             |
| Sort / expand hints   | Adding sort or expand returned the same listing                                     | No measured saving                                  |
| Sitemap               | `/<site>/siteMap.xml`, as advertised in robots.txt                                  | Case matters                                        |
| Sitemap completeness  | NREL has all 63; Adobe, Mastercard and NVIDIA have only 100 URLs                    | Cannot replace complete listing                     |
| Sitemap paging        | Adobe page, offset, start and p query variants repeat the same first 100            | No usable pagination found                          |
| Sitemap timestamps    | No lastmod, ETag or Last-Modified; no-store/no-cache                                | Cannot safely detect updates                        |
| Detail                | Adobe JSON detail 11,091 bytes, description 9,999 bytes; listing has no description | Detail still required                               |
| Conditional detail    | Adobe sends no ETag/Last-Modified and answers 200 to conditional headers            | No enabled validator                                |
| HTML / JSON-LD        | Adobe HTML 24,954 bytes; JSON-LD description 8,690 bytes                            | Larger response, different facts; no request saving |
| Relative posted dates | NREL, Adobe and Mastercard lists contain Posted Today/Yesterday/30+ Days Ago        | Fingerprints must continue ignoring relative time   |

Adobe's sitemap URLs were exactly the first 100 of 253 API rows. Replacing the listing with it would
hide 153 live postings and could wrongly close them. Never label that sitemap a complete board.

## Ranked follow-up plan

1. Re-map stored raw payloads on mapper-only changes. This avoids detail requests across all platforms,
   which dominate first syncs and version bumps. Requires explicit version separation and a way to find
   each posting's latest raw payload across changed-only packs. Architecture work, separate issue.
2. Oracle listing parameters: limit 200, stable posting-date order and facetsList NONE. Measured JPM
   listing requests fall from 69 to 35; estimated across the seven measured boards, 177 to 90.
3. Workday: split capped slices immediately after their first page, before fetching the remaining 99
   pages that the child slices will overlap. Potential saving is 99 requests per split slice, not yet an
   observed end-to-end saving. Must prove equal IDs and completeness on recorded and live boards first.
4. Workday: investigate selecting disjoint facet partitions and avoiding overlapping partitions. No
   measured improvement yet; preserve conservative partial status whenever coverage is uncertain.

Do not skip details, use incomplete sitemaps for closure, or infer edits from posted dates. Incremental
new-posting discovery trades away edit/closure freshness and ranks below avoiding redundant work.

## Reproduction

Use a serial client with at least 250 ms between requests and honor Retry-After:

```text
POST https://<tenant>.<wd>.myworkdayjobs.com/wday/cxs/<tenant>/<site>/jobs
{"appliedFacets":{},"limit":20,"offset":0,"searchText":""}
GET https://<tenant>.<wd>.myworkdayjobs.com/<site>/siteMap.xml
GET https://<tenant>.<wd>.myworkdayjobs.com/wday/cxs/<tenant>/<site><externalPath>
```

Continue offset paging to the first page's total, partition capped slices using returned facets, and compare
unique externalPath sets before claiming an optimization. The source observations above were recovered
from the original session's request results and survey; no platform code was changed for this research.
