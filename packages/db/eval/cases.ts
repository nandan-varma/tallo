import type { SearchSpec } from "@tallo/contracts";

/**
 * The standing search-quality set. Each case is a request the assistant might send (`spec`) with the truth written
 * by hand (`must`, `mustNot`), independent of the places table and the ranking. Words are matched as whole words
 * (plural and singular alike); a phrase needs all its words; a list of phrases is ORed.
 *
 * A returned posting is relevant when its title matches `must.title`, its place matches (`must.remote` or
 * `must.place`, whichever are set), its company matches `must.company`, and it has none of `mustNot.title`.
 * Keep the truth lists broad enough that a correct posting in another spelling still counts.
 */
export interface Must {
  /** Title phrases, ORed. A title matches a phrase when it has all of the phrase's words. */
  title: string[];
  /** Remote work (work mode `remote`) counts as a place match. */
  remote?: boolean;
  /** Location phrases, ORed, matched against the posting's location text. */
  place?: string[];
  /** Company names, ORed. Each must appear in the company name. */
  company?: string[];
}

export interface MustNot {
  /** Single title words; a title with any of them is wrong. */
  title?: string[];
}

export interface EvalCase {
  id: string;
  spec: SearchSpec;
  must: Must;
  mustNot?: MustNot;
}

const NYC = ["new york", "nyc", "brooklyn", "manhattan", "queens", "long island city"];
const BAY = [
  "san francisco",
  "san jose",
  "palo alto",
  "mountain view",
  "sunnyvale",
  "oakland",
  "menlo park",
  "redwood city",
  "santa clara",
  "cupertino",
  "bay area",
  "silicon valley",
  "berkeley",
  "fremont",
  "milpitas",
];
const SEATTLE = ["seattle", "bellevue", "redmond", "kirkland", "bothell", "tacoma", "everett"];
const DC = ["washington, dc", "washington dc", "arlington", "reston", "bethesda", "alexandria"];
const HOUSTON = ["houston", "katy", "sugar land", "the woodlands", "pearland", "humble"];
const CHICAGO = ["chicago", "evanston", "naperville", "schaumburg", "oak brook", "rosemont"];
const DALLAS = ["dallas", "plano", "irving", "frisco", "richardson", "fort worth", "addison"];
const LA = ["los angeles", "santa monica", "culver city", "burbank", "el segundo", "pasadena"];
const BOSTON = ["boston", "cambridge", "somerville", "waltham", "needham"];
const DENVER = ["denver", "englewood", "lakewood", "greenwood village", "broomfield", "boulder"];
const AUSTIN = ["austin", "round rock", "cedar park", "pflugerville"];
const TORONTO = [
  "toronto",
  "mississauga",
  "markham",
  "vaughan",
  "richmond hill",
  "oakville",
  "gta",
];
const VANCOUVER = ["vancouver", "burnaby", "surrey", "richmond, bc"];
const MONTREAL = ["montreal", "laval"];
const LONDON = ["london", "greater london"];
const UK = ["uk", "united kingdom", "london", "manchester", "cambridge", "edinburgh", "bristol"];
const BENGALURU = ["bengaluru", "bangalore", "whitefield", "karnataka"];
const HYDERABAD = ["hyderabad", "hitec city", "gachibowli", "madhapur", "secunderabad"];
const PUNE = ["pune", "pimpri", "hinjewadi", "kharadi"];
const GURGAON = ["gurgaon", "gurugram", "noida", "delhi", "new delhi", "ncr"];

export const EVAL_CASES: EvalCase[] = [
  // Software titles, remote and onsite
  {
    id: "backend-engineer-remote",
    spec: { queries: ["backend engineer"], locations: ["remote"] },
    must: { title: ["backend engineer"], remote: true },
    mustNot: { title: ["manager", "director"] },
  },
  {
    id: "data-scientist-remote",
    spec: { queries: ["data scientist"], locations: ["remote"] },
    must: { title: ["data scientist"], remote: true },
  },
  {
    id: "software-engineer-remote",
    spec: { queries: ["software engineer"], locations: ["remote"] },
    must: { title: ["software engineer"], remote: true },
  },
  {
    id: "senior-data-engineer-remote",
    spec: { queries: ["senior data engineer"], locations: ["remote"] },
    must: { title: ["senior data engineer"], remote: true },
  },
  {
    id: "junior-developer-remote",
    spec: { queries: ["junior developer", "junior software engineer"], locations: ["remote"] },
    must: { title: ["junior developer", "junior software engineer"], remote: true },
    mustNot: { title: ["senior", "staff", "principal"] },
  },
  {
    id: "software-intern-remote",
    spec: { queries: ["software engineering intern", "software intern"], locations: ["remote"] },
    must: { title: ["software engineering intern", "software intern"], remote: true },
    mustNot: { title: ["senior", "staff"] },
  },
  // Software titles, places
  {
    id: "frontend-engineer-nyc",
    spec: { queries: ["frontend engineer", "front end engineer"], locations: ["NYC"] },
    must: { title: ["frontend engineer", "front end engineer"], place: NYC },
  },
  {
    id: "ml-engineer-bay-area",
    spec: { queries: ["machine learning engineer"], locations: ["Bay Area"] },
    must: { title: ["machine learning engineer"], place: BAY },
  },
  {
    id: "senior-platform-engineer-seattle",
    spec: { queries: ["senior platform engineer"], locations: ["Seattle"] },
    must: { title: ["senior platform engineer"], place: SEATTLE },
  },
  {
    id: "devops-engineer-london",
    spec: { queries: ["devops engineer", "site reliability engineer"], locations: ["London"] },
    must: { title: ["devops engineer", "site reliability engineer"], place: LONDON },
  },
  {
    id: "security-engineer-dc",
    spec: { queries: ["security engineer"], locations: ["DC"] },
    must: { title: ["security engineer"], place: DC },
  },
  {
    id: "mobile-engineer-austin-or-remote",
    spec: { queries: ["ios engineer", "android engineer"], locations: ["Austin", "remote"] },
    must: { title: ["ios engineer", "android engineer"], remote: true, place: AUSTIN },
  },
  {
    id: "staff-engineer-anywhere",
    spec: { queries: ["staff engineer", "principal engineer"] },
    must: { title: ["staff engineer", "principal engineer"] },
    mustNot: { title: ["intern", "junior"] },
  },
  {
    id: "engineering-manager-dublin",
    spec: { queries: ["engineering manager"], locations: ["Dublin"] },
    must: { title: ["engineering manager"], place: ["dublin"] },
  },
  {
    id: "software-developer-berlin",
    spec: { queries: ["software developer"], locations: ["Berlin"] },
    must: { title: ["software developer"], place: ["berlin"] },
  },
  {
    id: "data-analyst-singapore",
    spec: { queries: ["data analyst"], locations: ["Singapore"] },
    must: { title: ["data analyst"], place: ["singapore"] },
  },
  // Places outside the US: India, Canada, UK
  {
    id: "software-engineer-bengaluru",
    spec: { queries: ["software engineer"], locations: ["Bengaluru"] },
    must: { title: ["software engineer"], place: BENGALURU },
  },
  {
    id: "data-engineer-hyderabad",
    spec: { queries: ["data engineer"], locations: ["Hyderabad"] },
    must: { title: ["data engineer"], place: HYDERABAD },
  },
  {
    id: "cloud-engineer-pune",
    spec: { queries: ["cloud engineer", "cloud architect"], locations: ["Pune"] },
    must: { title: ["cloud engineer", "cloud architect"], place: PUNE },
  },
  {
    id: "sre-gurgaon",
    spec: { queries: ["site reliability engineer"], locations: ["Gurgaon"] },
    must: { title: ["site reliability engineer"], place: GURGAON },
  },
  {
    id: "software-engineer-toronto",
    spec: { queries: ["software engineer"], locations: ["Toronto"] },
    must: { title: ["software engineer"], place: TORONTO },
  },
  {
    id: "data-engineer-montreal",
    spec: { queries: ["data engineer"], locations: ["Montreal"] },
    must: { title: ["data engineer"], place: MONTREAL },
  },
  {
    id: "qa-engineer-canada",
    spec: { queries: ["qa engineer", "test engineer"], locations: ["Canada"] },
    must: {
      title: ["qa engineer", "test engineer"],
      place: [...TORONTO, ...VANCOUVER, ...MONTREAL],
    },
  },
  {
    id: "ai-engineer-uk",
    spec: { queries: ["ai engineer", "machine learning engineer"], locations: ["UK"] },
    must: { title: ["ai engineer", "machine learning engineer"], place: UK },
  },
  {
    id: "software-engineer-remote-or-canada",
    spec: { queries: ["software engineer"], locations: ["remote", "Canada"] },
    must: { title: ["software engineer"], remote: true, place: [...TORONTO, ...VANCOUVER] },
  },
  // Non-software titles
  {
    id: "registered-nurse-houston",
    spec: { queries: ["registered nurse"], locations: ["Houston"] },
    must: { title: ["registered nurse"], place: HOUSTON },
  },
  {
    id: "accountant-chicago",
    spec: { queries: ["accountant"], locations: ["Chicago"] },
    must: { title: ["accountant"], place: CHICAGO },
  },
  {
    id: "sales-development-rep-remote",
    spec: { queries: ["sales development representative"], locations: ["remote"] },
    must: { title: ["sales development representative"], remote: true },
  },
  {
    id: "warehouse-associate-dallas",
    spec: { queries: ["warehouse associate"], locations: ["Dallas"] },
    must: { title: ["warehouse associate"], place: DALLAS },
  },
  {
    id: "product-manager-nyc",
    spec: { queries: ["product manager"], locations: ["NYC"] },
    must: { title: ["product manager"], place: NYC },
    mustNot: { title: ["assistant"] },
  },
  {
    id: "pharmacist-vancouver",
    spec: { queries: ["pharmacist"], locations: ["Vancouver"] },
    must: { title: ["pharmacist"], place: VANCOUVER },
  },
  {
    id: "ux-designer-los-angeles",
    spec: { queries: ["ux designer", "product designer"], locations: ["LA"] },
    must: { title: ["ux designer", "product designer"], place: LA },
  },
  {
    id: "marketing-manager-boston",
    spec: { queries: ["marketing manager"], locations: ["Boston"] },
    must: { title: ["marketing manager"], place: BOSTON },
  },
  {
    id: "technical-recruiter-remote",
    spec: { queries: ["technical recruiter", "recruiter"], locations: ["remote"] },
    must: { title: ["technical recruiter", "recruiter"], remote: true },
  },
  {
    id: "customer-success-manager-denver",
    spec: { queries: ["customer success manager"], locations: ["Denver"] },
    must: { title: ["customer success manager"], place: DENVER },
  },
  {
    id: "cdl-driver-texas",
    spec: { queries: ["cdl driver", "truck driver"], locations: ["Texas"] },
    must: { title: ["cdl driver", "truck driver"], place: ["texas", "tx"] },
  },
  // Company asks
  {
    id: "stripe-software-engineer",
    spec: { queries: ["software engineer"], companies: ["Stripe"] },
    must: { title: ["software engineer"], company: ["stripe"] },
  },
  {
    id: "openai-research-engineer",
    spec: { queries: ["research engineer", "research scientist"], companies: ["OpenAI"] },
    must: { title: ["research engineer", "research scientist"], company: ["openai"] },
  },
  {
    id: "google-software-engineer-nyc",
    spec: { queries: ["software engineer"], companies: ["Google"], locations: ["New York"] },
    must: { title: ["software engineer"], company: ["google"], place: NYC },
  },
  {
    id: "databricks-solutions-architect-remote",
    spec: {
      queries: ["solutions architect"],
      companies: ["Databricks"],
      locations: ["remote"],
    },
    must: { title: ["solutions architect"], company: ["databricks"], remote: true },
  },
];
