# Plan: app and data polish

Found while auditing the live site and API on 2026-11-22 (sampled 75 postings, 6 searches, 400 title
words, `descriptions`, error paths, and the web source). Nothing here is a correctness bug in the
database: every item is a gap between what the API already knows and what the app shows, plus two
data-quality items.

**Status: A, B, C and D12 are done and deployed; D10 is source-config curation for later.**
- A + C: `#220` (search sort/country/recency, company-only search, repeated params, `capped`/`expanded`
  notices, pay and date formatting).
- B: `#221` (status copy for manual collection, footer links).
- D12: `#222` (sandbox tenants removed and retired from the catalog).
- D10 (company display names in `sources/*.json`) is a curation task, not a bug: 1,139 boards have
  `company === key`, and most are legitimate lowercase brand names (`10times`, `6sense`, `1fin`). Leave
  them unless a reader would mistake one for a board token (as `sesai`).

## A. The app says less than the API knows (done: #220)

1. **Sorting is fixed to relevance.** `apps/web/src/lib/api.ts` hard-codes `sort: "relevance"`; the API's
   `sort=recent` (newest first, one hit per open location) is unreachable from the site. Add a two-state
   control to the form and carry it in the URL, the cursor and `searchHref`.
2. **`country` and `postedWithin` are plumbed but never filled.** `runSearch` binds both (and the cursor
   checks them), `specFrom` never produces them. Add a country field (2-letter codes) and a recency
   select (24 h / 7 d / 30 d) — the API validates 1–365 and refuses a bare location-only search, so the
   fields stay optional.
3. **Company-only search is blocked by the form.** `specFrom` and the API accept companies without a title,
   but the title `Input` is `required`. Make the title optional and explain the rule ("a title or a
   company").
4. **The page ignores what the API reports about the answer.** `SearchPage` carries `count`, `hasMore`,
   `capped`, `expanded.locations`, `expanded.remote`, `asOf`; `JobResults` shows only "Showing 1–20" and
   drops the rest. Show the total, a "results were capped at 300, refine the search" notice when
   `capped`, and "widened to nearby places / includes remote" when the API expanded the query.
5. **A multi-value URL is silently cut to one value.** `llms.txt` tells callers to repeat `title`
   (`?title=a&title=b`); `valuesFrom` reads `params.get` (first only), so the form shows one and
   re-submitting drops the rest. Read all values and join them with commas for display.

## B. Status page describes collection that no longer exists (done: #221)

6. **Copy assumes a schedule.** `StatusPage` calls a run within the hour "Collecting now" and says failing
   boards are "retried with back-off" — collection is manual (`tallo sweep`, run by hand), so the page will
   usually claim nothing is happening while the catalog is fresh. Say "Last collection run <relative>";
   drop the schedule language; keep the 14-day rule.
7. **Nothing on the site links to `/status`.** It is an orphan: `Base.astro` has no nav and the only
   reference in the app is a comment. Add it next to the llms.txt/search links (and from `/llms.txt`?
   no — that document is for machines).

## C. Formatting the reader can use (done: #220, with A)

8. **Pay is unformatted and inconsistent.** The API returns e.g. `USD 280000-425000 per year (Software
   Engineer)`; render `USD 280,000–425,000 a year` with an en dash, and drop or explain the trailing
   parenthetical. Same for hourly (`USD 25-32 per hour` → `USD 25–32 an hour`).
9. **Dates are raw ISO.** `Posted 2023-01-12` for a posting that is live today. Show relative age
   ("posted 2 days ago", "posted 3 months ago") with the ISO date in `title=`/`<time datetime>`; the
   sampled catalog has postings up to ~3.9 years old, and today they look identical to fresh ones.

## D. Data quality (D12 done: #222; D10 is curation)

10. **Some `company` values are bare board tokens.** e.g. `sesai` (SES AI), from `sources/greenhouse.json`,
    because the config's `company` is the board key. The DB correctly stores what the config says, so this
    is a source-config cleanup: give such boards a human display name. Find them by counting configs whose
    `company` matches `key` or is all lowercase without spaces.
11. **`/v1/titles` returns title _words_, not titles** (`a1`, `eng2` are real tokens of long titles). This is
    documented in OpenAPI ("Title words") but `llms.txt` should say it plainly too, or an agent will think
    the catalog holds postings titled "a1".

## E. Accepted / no action

- `?country=zz` answers `200` with zero results rather than `400`. Harmless; documenting it is enough.
- Expired Walmart ids cost two requests (a 307 plus the not-found page). Worth a redirect stop only if a
  first Walmart sync is repeated often; ~7 % of the sitemap.
- `postedAt` older than a year is the source's own first-published date, not a bug (rule: facts only).
- `locations` (a count) on a search hit versus `variants` (an array) on the posting: documented, keep.

## Test notes

Each web change needs a `StatusPage`/`SearchForm`/`JobResults` test in `apps/web/test`, and a formatting
helper gets a unit test (pay and relative dates are pure). The status copy change must keep the
`site-stats` schema untouched (no API deploy for B).
