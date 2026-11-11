import type { MappedJob } from "./job.ts";
import type { Json } from "./json.ts";

/**
 * A board only the Mac runner can reach (`params.egress: "local"`). Some platforms redirect requests
 * from the cloud's egress off their allowlist while answering the Mac normally, so the Worker never
 * claims these boards. The runner collects them as before.
 */
export const LOCAL_EGRESS = "local";
export const needsLocalEgress = (source: Pick<SourceConfig, "params">): boolean =>
  source.params.egress === LOCAL_EGRESS;

/** One configured recruiting surface (a board). Trusted configuration, never user input. */
export interface SourceConfig {
  /** Stable identity: `${platform}:${key}`. Never changes when execution moves between runners. */
  id: string;
  platform: string;
  /** Platform-specific board identifier (slug, tenant, ...). */
  key: string;
  company: string;
  /** Platform-specific extras, validated by the platform's own `parseParams`. */
  params: Record<string, string | number | boolean>;
}

/** Everything the source returned for one posting, untouched. */
export interface RawPosting {
  /** Source posting id (identity within the source). */
  id: string;
  /** The listing row exactly as the source returned it. */
  listing: Json;
  /** Payload from the platform's detail endpoint(s), when it has one. */
  detail?: Json;
}

/** `blocked`: the request was refused by the egress guard (a redirect off the allowlist), not by the source. */
type IssueCode = "http" | "schema" | "pagination" | "budget" | "detail" | "blocked";

export interface Issue {
  code: IssueCode;
  message: string;
  url?: string;
  postingId?: string;
}

/**
 * What a listing established. Closure may only be inferred when `complete` is true and the
 * listing is non-empty (or `emptyIsAuthoritative`). A platform that cannot finish listing throws.
 */
export interface Listing {
  complete: boolean;
  /** True only if an empty listing proves the board really has no jobs. */
  emptyIsAuthoritative: boolean;
}

export interface HttpResponse<T = Json> {
  status: number;
  url: string;
  data: T;
}

/** The only I/O a platform sees. Implemented by @tallo/http; trivially faked in tests. */
export interface Http {
  getJson(url: string, init?: HttpInit): Promise<HttpResponse>;
  postJson(url: string, body: Json, init?: HttpInit): Promise<HttpResponse>;
  getText(url: string, init?: HttpInit): Promise<HttpResponse<string>>;
}

export interface HttpInit {
  headers?: Record<string, string>;
  /** Treat these statuses as data (e.g. 404 means "board does not exist"). */
  okStatuses?: number[];
}

export interface CollectContext {
  http: Http;
  signal?: AbortSignal;
  /** Safety valve for runaway pagination, per source. */
  maxPostings: number;
  record(issue: Issue): void;
}

/**
 * A platform integration. One folder in @tallo/platforms owns list + detail + map + fixtures,
 * registered once. Collection is lossless; `map` is pure.
 */
export interface Platform {
  id: string;
  /** Bump when `map` changes so retained postings are re-processed. */
  version: number;
  /** Hosts this platform may contact (allowlist). Supports leading "*.". */
  hosts: string[];
  /** Throw on bad source configuration. */
  validate(source: SourceConfig): void;
  /** Stream listing rows; the return value says how complete the listing was. */
  list(source: SourceConfig, ctx: CollectContext): AsyncGenerator<RawPosting, Listing>;
  /**
   * Fetch extra per-posting data. Only called for postings whose fingerprint changed,
   * so daily runs stay cheap.
   */
  detail?(source: SourceConfig, posting: RawPosting, ctx: CollectContext): Promise<Json>;
  /** Listing content that signals a real change; drop volatile fields (e.g. "Posted 3 days ago"). */
  fingerprint?(listing: Json): Json;
  map(raw: RawPosting, source: SourceConfig): MappedJob;
}
