/** One search hit: only what a person skims in a list. A null field is unknown, never guessed. */
export type JobHit = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  workMode: string | null;
  /** The source's stated base pay with its own interval ("USD 90000-95000 per hour"), or null. */
  pay: string | null;
  postedAt: string | null;
  department: string | null;
};

export type JobRead = JobHit & {
  applyUrl: string | null;
  /** Facts as the source stated them (all locations, pay components, experience, source extras). */
  facts: Record<string, unknown>;
  /** The FULL description. Never truncated: pay and minimum requirements are usually at the bottom. */
  description: string | null;
};

/**
 * What the agent needs from the catalog. Implemented by the API Worker over D1/R2; the package never
 * imports a database. Every method sees only jobs the site shows (open, canonical, fresh source).
 */
export interface JobsPort {
  /**
   * Jobs matching any of the title phrases, merged, each at most once, at most `limit`. When `locations` is
   * given, a job must also mention at least one of them in its location text.
   */
  search(queries: string[], limit: number, options?: { locations?: string[] }): Promise<JobHit[]>;
  /** The compact record of each of these ids that is visible to the site; ids that are not are left out. */
  lookup(ids: string[]): Promise<JobHit[]>;
  /** One job with its full description, or null when it is not visible. */
  read(id: string): Promise<JobRead | null>;
}
