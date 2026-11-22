# Adding a platform

A platform is one folder under `packages/platforms/src/<id>/` plus one line in `src/index.ts`.
Nothing else changes: not contracts, not the db, not the runner.

## Steps

1. Explore the public API with curl. Note: list endpoint, pagination, detail endpoint, where description,
   locations, pay, department, dates and apply URL live, and what an unknown board returns.
2. Record fixtures into `packages/platforms/test/fixtures/<id>-list.json` (and `-detail.json`): 2 real rows,
   trimmed of huge unrelated blobs, never secrets.
3. Write `index.ts` exporting a `Platform`:
   - `hosts`: every hostname the platform may contact (allowlist; `*.suffix` allowed).
   - `validate(source)`: reject malformed `key`/`params`.
   - `list`: yield `{id, listing}` per posting untouched. Return `{complete, emptyIsAuthoritative}`.
     `complete` is true only when you saw the real end of the whole listing. If the response shape is
     unexpected, `throw new SchemaError(...)` (never return an empty list).
     `emptyIsAuthoritative` is true only if an empty answer proves the board has no jobs (an unknown
     board that also answers 200 `[]` means false).
   - `detail` (optional): per-posting extra payload. Only called for changed postings. A posting the source no
     longer has (a job page that says "not found", an expired id still listed by a sitemap) throws
     `PostingGone`: the engine drops it from the listing and the posting closes by the absence rule, instead of
     failing the board's details for every run.
   - `fingerprint` (optional): drop volatile fields (relative dates, counters).
   - `map`: pure. Read fields explicitly through `lookup(detail, listing)` (no spreads). Put typed facts in the
     typed fields; put source-specific leftovers worth searching later in `extras`; everything else
     stays in the raw payload. Use `describe(html...)` for description text and `locations([...])`.
     Map pay to `Money[]` with currency/interval/component, and experience to `Quantity[]`, only from
     structured source fields. Use the interval the source states and leave it `unknown` otherwise. Nothing
     is parsed from description text: the database stores what the source stated and the reader judges the rest.
4. Register it in `src/index.ts`.
5. Tests in `packages/platforms/test/platforms.test.ts`: list (with a fake `Http`), pagination/completeness,
   map assertions on fixtures, and the failure modes (malformed response, empty list).
6. Add sources: `sources/<id>.json` (`[{key, company, params?}]`). The file name is the platform id.
7. Verify live: `pnpm --filter @tallo/runner tallo verify <id>:<key> -n 5`. Check `warnings`, `presence`
   and `unmapped`; anything valuable in `unmapped` should be mapped or consciously left in raw.
8. Update `docs/platforms.md`, then `pnpm check`, then open a PR.

## Hard cases

- Result caps (Workday's 2,000): partition the query (facets, date ranges, locations) and dedupe; if a
  slice cannot be partitioned return `complete: false`.
- Sites needing a browser session: out of scope for the runner today; record in `docs/platforms.md` as blocked.
- Rate limits: prefer per-host settings in the runner over platform-specific sleeps.
