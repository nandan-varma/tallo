# Retailers and large employers: findings (2026-11-21)

Already covered by existing boards: Home Depot, Lowe's, Costco (iCIMS), Verizon, T-Mobile, Nike, Target, CVS (Workday), McDonald's (SmartRecruiters corporate board).
Added: Disney (Workday `disney/disneycareer`, wd5).

## Radancy TalentBrew (AT&T, Walgreens): built as `radancy`

- `www.att.jobs`: robots.txt disallows `/search-jobs/`, so listing is `sitemap.xml` (2,166 `/job/` URLs) and detail is the job page JSON-LD.
- `jobs.walgreens.com`: `/sitemap.xml` redirects to `/en/sitemap.xml`, which holds exactly 500 `/en/job/` URLs (capped), so the listing is `complete: false` there.
- Kroger is not on TalentBrew: `jobs.kroger.com` redirects to `krogerfamilycareers.com`, an Oracle Cloud HCM site (`eluq.fa.us2.oraclecloud.com`, `CX_2001`), already seeded in `sources/oraclecloud.json`.

## Not readable within limits

- Tesla, McDonald's careers site: 403 on robots.txt and pages (bot wall); skipped.
- Dell `jobs.dell.com`: 403; Dell Workday tenant guess did not resolve.
- Kroger, Starbucks, UPS, Lockheed Martin, Albertsons: hosts timed out from curl; Workday tenant guesses (`External`, brand names, wd1/3/5) returned nothing. Needs a browser to find the real site names.
- Best Buy (`careers.bestbuy.com/bby`), FedEx (`careers.fedex.com`), Publix (`jobs.publix.com`, BrassRing): pages reachable, listing surface not investigated.
- Workday root-URL redirect trick now answers 406; use browser-found site names instead.
