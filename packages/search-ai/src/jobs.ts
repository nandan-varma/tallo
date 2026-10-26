/** One search hit: only what a person skims in a list. A null field is unknown, never guessed. */
export type JobHit = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  workMode: string | null;
  pay: string | null;
  postedAt: string | null;
  department: string | null;
};

export type JobRead = JobHit & {
  applyUrl: string | null;
  /** Typed facts the catalog extracted (all locations, pay components, experience). */
  facts: Record<string, unknown>;
  /** The FULL description. Never truncated: pay and minimum requirements are usually at the bottom. */
  description: string | null;
};

/**
 * What the agent needs from the catalog. Implemented by the API Worker over D1/R2; the package never
 * imports a database. Both methods see only jobs the site shows (open, canonical, not hidden, fresh).
 */
export interface JobsPort {
  /**
   * Jobs matching any of the title phrases, merged, each at most once, at most `limit`. When `locations` is
   * given, a job must also mention at least one of them in its location text.
   */
  search(queries: string[], limit: number, options?: { locations?: string[] }): Promise<JobHit[]>;
  /** One job with its full description, or null when it is not visible. */
  read(id: string): Promise<JobRead | null>;
}
