# Own-site scrapers audit (walmart, microsoft, ibm, goldman), 2026-11-21

Findings from live checks; nothing here changes mapper output yet.

## Walmart
- Sitemap has no `lastmod` (only changefreq/priority), no ETag; pages are `no-store`, `last-modified` is the request time. No cheap change signal. Detail pages embed `effectiveDate` (updated) but only after fetching the page.
- About 10% of sampled sitemap ids (4 of 41) answer 307 to `/us/en/job-not-found`. The http layer follows the redirect, the page has no `jobDetails`, so detail throws and the run is marked details-incomplete every run. Next step: let a platform signal "posting gone" (a typed error the engine skips without an issue or incomplete flag); never close from it (rule 2). Not done: needs an engine change in `packages/collect/src/engine.ts`.
- Unmapped payload fields worth a look: `createdAt`, `recruitingStartDate`, `shifts`, `organizationData`, `jobType`, `payPlanData.amount`.

## Microsoft
- The board is about 2,360 positions: about 237 list pages plus one detail call per new or changed posting, so a first sync is about 2,600 calls and steady state is much lower (fingerprint already drops volatile fields).
- `num`, `limit`, `pageSize`, `size`, `rows`, `count` on `/api/pcsx/search` are ignored (10 rows max). `/api/apply/v2/jobs` answers "Not authorized for PCSX". No bulk detail endpoint found.

## IBM, Goldman
- IBM: `indexedDate`, skills, legal entity already in extras. Goldman: `listing.createdDate` is unmapped; `updatedAt` and `expiresAt` are absent from the source.
