# Adding sources (companies / boards)

Sources are trusted configuration: `sources/<platform>.json`, an array of
`{ "key": "...", "company": "...", "params": { ... } }`. The platform comes from the file name; the source id
is `<platform>:<key>`.

| Platform        | key                                        | params                                                                   |
| --------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| greenhouse      | board token (`boards.greenhouse.io/<key>`) | `region: "eu"` for the EU host                                           |
| lever           | company slug (`jobs.lever.co/<key>`)       | `region: "eu"`                                                           |
| ashby           | board name (`jobs.ashbyhq.com/<key>`)      | none                                                                     |
| smartrecruiters | company identifier                         | none                                                                     |
| workday         | `tenant/site`                              | `wd` (e.g. `wd5`), from `https://<tenant>.<wd>.myworkdayjobs.com/<site>` |
| google          | `careers` (one board per company site)     | none                                                                     |
| apple           | `careers` (one board per company site)     | none                                                                     |

## For an exploration agent (given a list of careers URLs)

1. Identify the platform from the URL or page source (see table above for URL shapes).
2. Add the entry (keep each file sorted by key, no duplicates; `tallo sources` validates all of them).
3. Run `pnpm --filter @tallo/runner tallo verify <platform>:<key> -n 5`. The board is good only if
   `listed > 0`, `warnings` is empty and the sample job looks right (US tech boards are the priority).
4. Dead or empty boards: do not add. Unknown platforms: note the URL in the PR description; a new platform
   is a separate task (`docs/adding-a-platform.md`).
5. Open one PR per batch with a table of what was added/rejected and why.

Company display name: the name users recognize, not the slug.
