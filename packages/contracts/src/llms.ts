import {
  DESCRIPTION_CHUNK,
  DESCRIPTION_MAX_CHUNK,
  PUBLIC_MAX_URL_CHARS,
  PUBLIC_ORIGIN,
  PUBLIC_RATE_PER_MINUTE,
  publicDescriptionSchema,
  publicSearchSchema,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
} from "./public-api.ts";
import { SEARCH_RESULT_CAP } from "./search.ts";

/** One line per parameter: its name, then what it takes. The text is the schema's own description. */
function parameterLines(shape: Record<string, { description?: string }>): string {
  return Object.entries(shape)
    .map(([name, field]) => `- ${name}: ${field.description ?? ""}`)
    .join("\n");
}

/**
 * The text of `/llms.txt`: what Tallo is, the three public endpoints with their parameters and one example each, the
 * response shapes, how to search, the limits and how to read the fields. Parameter lines come from the same zod
 * schemas the API validates with, so the document cannot drift from the routes (see the API's llms test).
 */
export function llmsText(): string {
  return `# Tallo

> Tallo is a public, read-only index of job postings. It collects them straight from company job boards and keeps what each source states about a posting. It does not judge fit: that is your job, with the person you are helping. Every result links to the employer's own application page.

Base URL: ${PUBLIC_ORIGIN}. No account, no key. GET only. Responses are JSON. Tallo does not apply for anyone and does not know the person.

## Endpoints

### GET /v1/search
Open postings whose title matches, best matches first. Descriptions are never included here.

Parameters:
${parameterLines(publicSearchSchema.shape)}

Example: curl -s "${PUBLIC_ORIGIN}/v1/search?title=backend+engineer&location=remote&limit=10"

Response: {"results": [{"id", "title", "company", "location", "workMode", "pay", "postedAt", "department", "applyUrl", "locations"}], "next": cursor or null, "note": text}

### GET /v1/jobs/:id
One open posting: its facts, its other open locations (variants), and the first ${DESCRIPTION_CHUNK} characters of its description. A closed posting, or one whose source has stopped listing, answers 404.

Example: curl -s "${PUBLIC_ORIGIN}/v1/jobs/123"

Response: {"id", "title", "company", "location", "workMode", "pay", "postedAt", "department", "employmentType", "applyUrl", "variants": [{"id", "location", "workMode", "postedAt", "applyUrl"}], "descriptionChars", "description", "descriptionNext"}

### GET /v1/jobs/:id/description
The rest of a description, in chunks.

Parameters:
${parameterLines(publicDescriptionSchema.shape)}

Example: curl -s "${PUBLIC_ORIGIN}/v1/jobs/123/description?offset=4000"

Response: {"id", "offset", "descriptionChars", "description", "descriptionNext"}. Call again with offset set to descriptionNext until it is null.

## Errors

A 4xx answer is {"error": {"code", "message", "hint"}}. The message says what was wrong and the hint shows the fix: correct the request and try once more. 414 means the URL is longer than ${PUBLIC_MAX_URL_CHARS} characters.

## How to search

1. Search with two to four specific titles (backend engineer, platform engineer) and the places the person named. Add a company only when the person named one.
2. Read the results. Take next only while the results still fit, and stop after a few pages.
3. Fetch /v1/jobs/:id only for postings on the shortlist.
4. Read more of a description only when the first chunk does not settle the question.

## Limits

- Search limit: 1 to ${SEARCH_MAX_LIMIT}, default ${SEARCH_DEFAULT_LIMIT}. Description chunk: 1 to ${DESCRIPTION_MAX_CHUNK}, default ${DESCRIPTION_CHUNK}.
- A search lists at most ${SEARCH_RESULT_CAP} results in total. There is no count.
- About ${PUBLIC_RATE_PER_MINUTE} requests a minute per address. Over that answers 429 with Retry-After.
- Answers are cached: searches for up to 5 minutes, postings for up to an hour. Keep your own copy rather than asking again.

## Reading the fields

- pay is only what the source stated, as text such as "USD 150000-180000 per year". null means the source stated none. Do not estimate it.
- postedAt is the date the source states (YYYY-MM-DD), or null.
- location is the place text the source gave. workMode is remote, hybrid, onsite, or null.
- locations (search) is how many postings of the same role the result groups. variants (job) lists each open location.
- applyUrl goes straight to the employer's application page. Link to it; do not submit anything there for the person.
- null always means unknown. Do not guess a value.

## Etiquette

Cache answers. Do not poll. Do not crawl or enumerate ids: search, then open the postings on the shortlist. Only the paths above are served.
`;
}
