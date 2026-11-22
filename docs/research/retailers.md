# Retailers and large employers: findings (2026-11-21)

Already covered by existing boards: Home Depot, Lowe's, Costco (iCIMS), Verizon, T-Mobile, Nike, Target, CVS (Workday), McDonald's (SmartRecruiters corporate board).
Added: Disney (Workday `disney/disneycareer`, wd5).

## Radancy TalentBrew (AT&T, Walgreens, likely Kroger): not built yet

- `www.att.jobs`: robots.txt disallows `/search-jobs/`, so listing must use `sitemap.xml` (about 2,165 `/job/<city>/<slug>/<org>/<id>` URLs). Each job page carries a schema.org JobPosting JSON-LD (title, description, datePosted, validThrough, jobLocation, hiringOrganization).
- `jobs.walgreens.com`: robots allows all, but `sitemap.xml` lists only 500 `/en/job/` URLs (capped), so a sitemap listing cannot be complete. Needs a partitioned source (category pages) before it can close jobs.
- Next step: generic `talentbrew` platform, key = host, list from sitemap, detail from JSON-LD; `complete` false when the sitemap holds exactly 500 jobs.

## Not readable within limits

- Tesla, McDonald's careers site: 403 on robots.txt and pages (bot wall); skipped.
- Dell `jobs.dell.com`: 403; Dell Workday tenant guess did not resolve.
- Kroger, Starbucks, UPS, Lockheed Martin, Albertsons: hosts timed out from curl; Workday tenant guesses (`External`, brand names, wd1/3/5) returned nothing. Needs a browser to find the real site names.
- Best Buy (`careers.bestbuy.com/bby`), FedEx (`careers.fedex.com`), Publix (`jobs.publix.com`, BrassRing): pages reachable, listing surface not investigated.
- Workday root-URL redirect trick now answers 406; use browser-found site names instead.
