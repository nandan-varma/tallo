# Retailers and large employers: findings (2026-11-21)

Already covered by existing boards: Home Depot, Lowe's, Costco (iCIMS), Verizon, T-Mobile, Nike, Target, CVS (Workday), McDonald's (SmartRecruiters corporate board).
Added: Disney (Workday `disney/disneycareer`, wd5).

## Radancy TalentBrew (AT&T, Walgreens): built as `radancy`

- `www.att.jobs`: robots.txt disallows `/search-jobs/`, so listing is `sitemap.xml` (2,166 `/job/` URLs) and detail is the job page JSON-LD.
- `jobs.walgreens.com`: `/sitemap.xml` redirects to `/en/sitemap.xml`, which holds exactly 500 `/en/job/` URLs (capped), so the listing is `complete: false` there.
- Kroger is not on TalentBrew: `jobs.kroger.com` redirects to `krogerfamilycareers.com`, an Oracle Cloud HCM site (`eluq.fa.us2.oraclecloud.com`, `CX_2001`), already seeded in `sources/oraclecloud.json`.

## Listing surfaces for the issue #186 list (checked 2026-11-22; robots.txt respected, no 403 or bot wall bypassed)

Done:
- Kroger: `jobs.kroger.com` redirects to `krogerfamilycareers.com`, an Oracle Cloud HCM site (`eluq.fa.us2.oraclecloud.com`, `CX_2001`); already seeded in `sources/oraclecloud.json`.
- Dell: `jobs.dell.com` is an Oracle Cloud HCM front end whose candidate site lives on `enterpriseplatform.dell.com` (`CX_1001`, site path `careers`, 589 requisitions). Seeded as `oraclecloud:enterpriseplatform.dell.com`; that host is the one custom host `oraclecloud` accepts. The HCM API answers; the earlier 403 was from `jobs.dell.com` itself, which now answers 200 for browsers.

Feasible, not built (each needs its own platform or a generalised one):
- Starbucks: built as `starbucks`. `microsoft` and `starbucks` are two sites of one Eightfold PCSX implementation (`packages/platforms/src/eightfold`), kept as separate platform ids so the shipped Microsoft source id and data do not move. `apply.starbucks.com`, domain `starbucks.com`, about 21,500 postings; dry run clean (`tallo verify starbucks:starbucks.com -n 5`).
- FedEx: built as `fedex` (see `docs/platforms.md`): the two `-en` sitemaps (tenants `a0a4453b` US/Canada and `c84076ce` international) as a fixed set, job page JSON-LD for the detail. Other locale sitemaps repeat the same postings.
- Publix: `jobs.publix.com` is WordPress; `job_opening-sitemap.xml` lists about 430 `/job-opening/<role>/` pages, but they are role-level pages (grocery clerk, produce clerk) with no `JobPosting` JSON-LD, and the actual requisitions live in BrassRing (robots-restricted search). Role pages are not postings; skipped.
- Best Buy: `careers.bestbuy.com/bby` is a ServiceNow portal; the sitemap (`bestbuy.service-now.com/api/93622/seo/sitemap`) lists about 1,450 `jobs.bestbuy.com/bby?id=...` URLs, but the portal renders client-side and no static JSON-LD or public list API was found by curl. Needs a browser inspection of the widget requests.
- UPS: built as `phenom` (key `www.jobs-ups.com`). robots.txt disallows only apply, cart, chatbot and `*/px-widgets` paths, so `POST /widgets` (`ddoKey: "refineSearch"`, the call `/us/en/search-results` makes itself) and the job pages are allowed. The widget returns the US English board in pages of 100 (`totalHits` 4,255 on 2026-11-22; nothing past offset 10,000). The job page embeds the whole requisition record in `phApp.ddo.jobDetail`, which includes internal HR fields that name people (employee being replaced, justification, supervisory org); the collector never keeps it and reads only the public `JobPosting` JSON-LD for the description. A job that is closed answers 410. Dry run clean (`tallo verify phenom:www.jobs-ups.com -n 5`).

Blocked or unresolved:
- Lockheed Martin: `www.lockheedmartinjobs.com` serves a 404 for robots.txt, sitemap and search (it redirects through `/cgi-bin/ext_redir.pl` to a generic 404); no listing host found.
- Albertsons: `careers.albertsonscompanies.com` does not connect and `www.albertsonscompanies.com/careers/` answers 403 (bot wall); skipped, not bypassed.
- Tesla, McDonald's careers site: 403 on robots.txt and pages (bot wall); skipped.
