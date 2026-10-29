import type { Db } from "../src/db.ts";
import { schema } from "../src/index.ts";

/**
 * A small catalog for CI: postings that the cases in `cases.ts` should find, postings they should not, and a broad
 * block of onsite "Software Engineer" rows that is larger than the candidate window. The last block is what makes
 * the remote and collapse fixes measurable in memory: a remote posting with a longer title ranks below the cut.
 */
type Row = [
  company: string,
  title: string,
  location: string,
  workMode: "remote" | "hybrid" | "onsite",
  req?: string,
];

export const FIXTURE_ROWS: Row[] = [
  ["Acme", "Backend Engineer", "Remote - United States", "remote"],
  ["Acme", "Engineering Manager, Backend", "Remote - United States", "remote"],
  ["Globex", "Backend Engineer, Payments", "San Francisco, CA", "onsite"],
  ["Initech", "Senior Backend Engineer", "Remote, Canada", "remote"],
  ["Umbrella", "Data Scientist", "Remote", "remote"],
  ["Umbrella", "Data Scientist", "Seattle, WA", "onsite"],
  ["Hooli", "Software Engineer, Remote Platform", "Remote - US", "remote"],
  ["Wayne", "Senior Data Engineer", "Remote - US", "remote"],
  ["Wayne", "Senior Data Engineer", "New York, NY", "onsite"],
  ["Stark", "Junior Developer", "Remote", "remote"],
  ["Stark", "Senior Developer", "Remote", "remote"],
  ["Pied Piper", "Software Engineering Intern", "Remote - US", "remote"],
  ["Pied Piper", "Staff Software Engineer", "Remote - US", "remote"],
  ["Soylent", "Frontend Engineer", "New York, NY", "onsite"],
  ["Soylent", "Frontend Engineer", "Brooklyn, NY", "hybrid"],
  ["Vandelay", "Front End Engineer", "Queens, NY", "onsite"],
  ["Vandelay", "Marketing Manager", "New York, NY", "onsite"],
  ["Cyberdyne", "Machine Learning Engineer", "San Jose, CA", "onsite"],
  ["Cyberdyne", "Machine Learning Engineer", "Sunnyvale, CA", "onsite"],
  ["Cyberdyne", "Machine Learning Engineer", "Austin, TX", "onsite"],
  ["Tyrell", "Senior Platform Engineer", "Seattle, WA", "onsite"],
  ["Tyrell", "Senior Platform Engineer", "Bellevue, WA", "hybrid"],
  ["Tyrell", "Platform Engineer", "Berlin, Germany", "onsite"],
  ["Monsters", "Site Reliability Engineer", "London, United Kingdom", "onsite"],
  ["Monsters", "DevOps Engineer", "Manchester, UK", "onsite"],
  ["Gringotts", "Security Engineer", "Washington, DC", "onsite"],
  ["Gringotts", "Security Engineer", "Arlington, VA", "hybrid"],
  ["Gringotts", "Security Engineer", "Seattle, WA", "onsite"],
  ["Oscorp", "iOS Engineer", "Austin, TX", "onsite"],
  ["Oscorp", "Android Engineer", "Remote - US", "remote"],
  ["Massive", "Staff Engineer", "Chicago, IL", "onsite"],
  ["Massive", "Principal Engineer", "Remote", "remote"],
  ["Massive", "Software Engineering Intern", "Chicago, IL", "onsite"],
  ["Dunder", "Engineering Manager", "Dublin, Ireland", "onsite"],
  ["Dunder", "Software Developer", "Berlin, Germany", "onsite"],
  ["Dunder", "Data Analyst", "Singapore", "onsite"],
  ["Nimbus", "Software Engineer", "Bengaluru, Karnataka, India", "onsite"],
  ["Nimbus", "Software Engineer II", "Whitefield, Bangalore", "onsite"],
  ["Nimbus", "Data Engineer", "Hyderabad, Telangana, India", "onsite"],
  ["Nimbus", "Data Engineer", "Hitec City, Hyderabad", "onsite"],
  ["Nimbus", "Cloud Engineer", "Pune, Maharashtra, India", "onsite"],
  ["Nimbus", "Cloud Architect", "Hinjewadi, Pune", "hybrid"],
  ["Nimbus", "Site Reliability Engineer", "Gurugram, Haryana, India", "onsite"],
  ["Nimbus", "Site Reliability Engineer", "Noida", "onsite"],
  ["Maple", "Software Engineer", "Toronto, Ontario, Canada", "hybrid"],
  ["Maple", "Software Engineer", "Mississauga, ON", "onsite"],
  ["Maple", "Software Engineer", "Vancouver, BC", "onsite"],
  ["Maple", "Data Engineer", "Montreal, Quebec, Canada", "onsite"],
  ["Maple", "QA Engineer", "Toronto, Canada", "onsite"],
  ["Maple", "Test Engineer", "Vancouver, Canada", "remote"],
  ["Crown", "AI Engineer", "London, UK", "hybrid"],
  ["Crown", "Machine Learning Engineer", "Edinburgh, Scotland", "onsite"],
  ["Crown", "Software Engineer", "Cambridge, UK", "onsite"],
  ["Mercy", "Registered Nurse", "Houston, TX", "onsite"],
  ["Mercy", "Registered Nurse", "Katy, TX", "onsite"],
  ["Mercy", "Pharmacist", "Vancouver, BC", "onsite"],
  ["Mercy", "Pharmacist", "Richmond, BC", "onsite"],
  ["Ledger", "Accountant", "Chicago, IL", "onsite"],
  ["Ledger", "Accountant", "Evanston, IL", "onsite"],
  ["Ledger", "Sales Development Representative", "Remote - US", "remote"],
  ["Crate", "Warehouse Associate", "Dallas, TX", "onsite"],
  ["Crate", "Warehouse Associate", "Plano, TX", "onsite"],
  ["Crate", "Product Manager", "New York, NY", "onsite"],
  ["Crate", "Product Manager Assistant", "New York, NY", "onsite"],
  ["Lumen", "UX Designer", "Los Angeles, CA", "onsite"],
  ["Lumen", "Product Designer", "Santa Monica, CA", "hybrid"],
  ["Lumen", "Marketing Manager", "Boston, MA", "onsite"],
  ["Lumen", "Marketing Manager", "Cambridge, MA", "onsite"],
  ["Lumen", "Technical Recruiter", "Remote - US", "remote"],
  ["Lumen", "Customer Success Manager", "Denver, CO", "onsite"],
  ["Lumen", "Truck Driver", "Dallas, TX", "onsite"],
  ["Lumen", "CDL Driver", "Houston, TX", "onsite"],
  ["Stripe", "Software Engineer, Payments", "Remote - US", "remote"],
  ["Stripe", "Account Executive", "Remote - US", "remote"],
  ["OpenAI", "Research Engineer", "San Francisco, CA", "hybrid"],
  ["OpenAI", "Research Scientist", "Remote", "remote"],
  ["Google", "Software Engineer", "New York, NY", "onsite"],
  ["Google", "Software Engineer", "Mountain View, CA", "hybrid"],
  ["Databricks", "Solutions Architect", "Remote - US", "remote"],
  ["Databricks", "Solutions Architect", "Amsterdam", "onsite"],
];

/** Onsite "Software Engineer" postings, one company each, in mid-size US cities: more than the candidate cut. */
const BULK_CITIES = [
  "Seattle, WA",
  "Boston, MA",
  "Austin, TX",
  "Denver, CO",
  "Chicago, IL",
  "Atlanta, GA",
];
const BULK_COUNT = 2100;

/** The rows as they are stored: one company per row, so nothing collapses in the bulk block. */
export function fixtureRows(): Row[] {
  const bulk: Row[] = Array.from({ length: BULK_COUNT }, (_, i) => [
    `Bulk ${i}`,
    "Software Engineer",
    BULK_CITIES[i % BULK_CITIES.length] ?? "Seattle, WA",
    "onsite",
  ]);
  return [...FIXTURE_ROWS, ...bulk];
}

/** Writes the fixture into an empty database. `now` is the time the sources were last listed. */
export async function seedFixture(db: Db, now: number): Promise<void> {
  const rows = fixtureRows();
  const companies = [...new Set(rows.map(([company]) => company))];
  for (const company of companies) {
    const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await db
      .insert(schema.sources)
      .values({
        id: `greenhouse:${slug}`,
        platform: "greenhouse",
        key: slug,
        company,
        companySlug: slug,
        params: {},
        lastListedAt: now,
      })
      .onConflictDoNothing();
  }
  const values = rows.map(([company, title, location, workMode, req], i) => {
    const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return {
      sourceId: `greenhouse:${slug}`,
      postingId: `fx${i}`,
      company,
      companySlug: slug,
      title,
      excerpt: title,
      jdHash: `fx-${i}`,
      jdBytes: 1,
      sourceHash: "s",
      facts: {},
      sortAt: i + 1,
      firstSeenAt: 1,
      updatedAt: 1,
      locationText: location,
      workMode,
      requisitionId: req ?? null,
    };
  });
  for (let i = 0; i < values.length; i += 200) {
    await db.insert(schema.jobs).values(values.slice(i, i + 200));
  }
}
