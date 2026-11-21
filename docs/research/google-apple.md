# Google careers: measured public surface

Research for the Google collector. Measured on 2026-11-21 from this Mac, anonymously, with
one request in flight unless noted. No production ingest, no `.env` and no credentials were used.

## Google

- Board: `https://www.google.com/about/careers/applications/jobs/results/?page=N`, a server-rendered
  HTML page. No API and no per-job detail.
- The `ds:1` `AF_initDataCallback` payload holds the page of records and the whole-board total:
  `data[0]` is the page, `data[2]` the total (3,015 on 2026-11-21), `data[3]` the page size (20).
  The page HTML is about 1.36 MB; the `ds:1` array is about 114 KB. 151 pages covered the whole board.
- A record is a positional array: `[0]` id, `[1]` title, `[3]` responsibilities HTML, `[4]`
  qualifications HTML, `[5]` company path, `[7]` company name, `[8]` locale, `[9]` places,
  `[10]` overview HTML, `[14]` published `[unix seconds, nanos]`, `[20]` target level.
  Each place is `[display, addresses, city, postal, region, country code]`.
- `?page=152` (past the end) is not needed on a stable run; pagination stops at
  `ceil(total / page_size)`. A changed total, a short non-final page or a repeated id reports
  `complete: false`.
- The old `careers.google.com/api/v3/search` endpoint is retired. It is not used.

## Cost

| Collector |    List requests | Detail requests (first full sync) |                                   Bytes |
| --------- | ---------------: | --------------------------------: | --------------------------------------: |
| Google    | 151 (3,015 rows) |                                 0 |     ~205 MB HTML; ~17 MB of `ds:1` rows |
| Apple     | 324 (6,474 rows) |                             6,474 | ~10 MB listing JSON; ~88 MB detail JSON |

Steady state is much cheaper: Google still reads its 151 pages because the board is only available as
paged HTML; Apple lists 324 pages and fetches details only for changed postings. Both are in
`sources/hot.json`, so they are scheduled daily.

## Deliberate limits

- No pay is typed. Google states pay in overview HTML; Apple states it in a Pay & Benefits footer.
  Both are prose, so they remain in the description/raw payload and `compensation` stays empty.
- No work mode or experience is inferred. Apple's `homeOffice: true` is the only work-mode statement
  and maps to `remote`; an unset field stays unset.
- The positional Google record has no field names. A shifted index would be a silent wrong mapping,
  so `map` reads fixed indices and the fixture test pins the mapping.
- Offset pagination over a live board can shift when postings are added or expire during a run. Both
  collectors report `complete: false` when the reported total changes, a non-final page is short, or
  an id repeats; closure is then skipped by the engine.
