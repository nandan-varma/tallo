# Status

Complete and deployed. Collection is manual (`tallo sweep` / `tallo sync`); nothing is scheduled and the cloud
collector is built but off (`COLLECT_ENABLED` `"0"`). Postings hide after 14 days without a sweep. Design reasons:
`docs/decisions.md`; operating: `docs/runbook.md`; platforms: `docs/platforms.md`. Mac/cloud parity check:
`pnpm parity` (verified on `lever:15five`).

## Catalog (2026-11-22 recount)

9,528 boards on 26 platforms at this recount (727,726 open postings, 9,303 employers). Since then: +392 boards
(Rippling, Gem, Pinpoint, Breezy), the `radancy`, `phenom` and `bestbuy` platforms and Starbucks, FedEx and Dell.

## Next

Work and decisions live in GitHub issues; this is only the map.

- **Credits-gated (hold until the monthly Cloudflare credits renew):** #264 cloud collector rollout, #265 D1 backup
  schedule, #266 reprocess inferred rows, #270 the overdue sweep and first syncs of the new collectors (Starbucks,
  FedEx, Radancy incl. Walgreens' full listing, Dell, UPS `phenom`, Best Buy).
- **#137 Apple:** a cloud collection trial was started 2026-11-22; read its result there, then decide Mac or cloud.
- **#271** Oracle boards that can never report complete (documented limit); **#269** TypeScript 7 / cf held back.
- **Spend caps:** \$1 hard caps on the Workers and Durable Objects families (Cloudflare dashboard). Hitting one blocks
  usage, including the public site, until the next billing period.
- **Releases:** `apps/api` pins `wrangler` 4.152.0 because `cf` 1.0.0-beta.13 cannot deploy with newer ones.
  `pnpm test` includes a local-D1 check of the run-start path (`apps/api/test/d1.test.ts`); the unit tests alone cannot
  catch D1-only failures.

## Known limits (accepted)

- Search lists at most 300 results per query (`SEARCH_RESULT_CAP`); refine the query rather than page deeper.
- `countryCode`, `postedAt`, pay and work mode are null where the source states nothing; they are never inferred.
- Oracle boards larger than 10,000 postings (Dollar General) are never reported complete, so they never close
  postings. Two Oracle boards (eeho, edel) end partial with "Short page". Partial runs never close postings.
- Uber's careers API path is disallowed by its robots.txt, HirePro needs a captcha, and Eightfold tenants answer 403:
  none of them is scraped.
- A first Walmart sync is about 15,300 requests, and about 7% of its sitemap ids are expired: those answer a
  job-not-found page and are dropped from the listing as `gone` (they close by absence), so the board can finish.
  Microsoft is about 2,600 requests.
- About 42 Rippling, Gem, Pinpoint and Breezy boards were added without a `tallo verify` run; a failing one shows as
  a partial or dead board.
