# Status

Complete and deployed. Collection is manual (`tallo sweep` / `tallo sync`); nothing is scheduled and the cloud
collector is built but off (`COLLECT_ENABLED` `"0"`). Postings hide after 14 days without a sweep. Design reasons:
`docs/decisions.md`; operating: `docs/runbook.md`; platforms: `docs/platforms.md`. Mac/cloud parity check:
`pnpm parity` (verified on `lever:15five`).

## Catalog (2026-11-22 recount)

9,528 boards on 26 platforms, 727,726 open postings, 9,303 employers.

## Next

- Sweep: Workday 403 boards and Oracle 38 boards due (`--stale-hours 20`), then the full sweep at 144 h.
- Stuck, needs a fresh lane rather than new settings: Oracle 8-9 boards (`fa.us2` 429s; let the pod cool), 3 permanent
  Greenhouse 404s, 1 ashby, 1 meta, 1 Microsoft board.
- Open issues: #183 Goldman/Walmart unread fields, #185 Radancy, #186 listing surface for large retailers,
  #188 Breezy descriptions, #189 more boards, #142 Google `postedAt`, #137 Apple resume, #9 source discovery.

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
