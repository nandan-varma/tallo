/**
 * What a person's place word means in posting locations. A reviewed lookup of aliases, not inference: a word that
 * is not in the table passes through as the person wrote it. Each entry lists the strings postings use; every
 * string is matched as all of its words (see `ftsLocations`), so "Washington DC" never matches Seattle.
 *
 * Collisions this table avoids on purpose:
 * - "LA" is never a token: "la" means the Los Angeles metro, and Louisiana's "LA" is never searched.
 * - "NY" and "WA" are not in city lists; a bare state abbreviation is only used by the state's own entry.
 * - "Washington" alone means the state (Seattle metro, "WA"); the capital needs "DC", "Washington DC" or "D.C.".
 * - Cities that share a name with a large place elsewhere (London, Ontario; Dublin, Ohio) are matched as written.
 */

interface Place {
  /** Every way the person may write it, lowercase, punctuation as spaces ("d.c." is "d c"). */
  names: string[];
  /** What postings call it. Ignored for `remote`. */
  locations: string[];
  /** Remote work: a work-mode match on the posting, not a location text match. */
  remote?: true;
}

const SEATTLE_METRO = [
  "Seattle",
  "Bellevue",
  "Redmond",
  "Kirkland",
  "Bothell",
  "Renton",
  "Issaquah",
  "Sammamish",
  "Tacoma",
  "Everett",
  "Kent",
  "Burien",
];
const LOS_ANGELES_METRO = [
  "Los Angeles",
  "Santa Monica",
  "Culver City",
  "Pasadena",
  "Burbank",
  "El Segundo",
  "Glendale",
  "Long Beach",
  "Playa Vista",
  "Venice",
  "Hollywood",
  "Torrance",
  "Manhattan Beach",
  "Irvine",
];
const BAY_AREA = [
  "San Francisco",
  "SF",
  "San Jose",
  "Palo Alto",
  "Mountain View",
  "Sunnyvale",
  "Oakland",
  "Menlo Park",
  "Redwood City",
  "Santa Clara",
  "Cupertino",
  "San Mateo",
  "South San Francisco",
  "Fremont",
  "Berkeley",
  "Foster City",
  "Los Altos",
  "Milpitas",
  "Emeryville",
  "Burlingame",
  "Bay Area",
  "Los Gatos",
  "Campbell",
  "Pleasanton",
  "San Carlos",
  "Belmont",
  "Hayward",
  "San Leandro",
  "Silicon Valley",
];

const PLACES: Place[] = [
  {
    names: ["nyc", "ny", "new york", "new york city", "manhattan", "brooklyn"],
    locations: [
      "New York",
      "NYC",
      "Brooklyn",
      "Manhattan",
      "Queens",
      "Bronx",
      "Long Island City",
      "Staten Island",
    ],
  },
  {
    names: ["bay area", "sf bay area", "san francisco", "sf", "silicon valley", "the bay"],
    locations: BAY_AREA,
  },
  { names: ["seattle", "seattle area", "greater seattle"], locations: SEATTLE_METRO },
  {
    names: ["washington", "washington state", "wa", "state of washington"],
    locations: [...SEATTLE_METRO, "WA", "Washington State", "Spokane"],
  },
  {
    names: ["dc", "washington dc", "d c", "washington d c", "dc metro", "dc area"],
    locations: [
      "Washington, DC",
      "DC",
      "Arlington, VA",
      "Reston, VA",
      "Bethesda, MD",
      "Alexandria, VA",
    ],
  },
  {
    names: ["austin", "austin tx", "austin texas", "austin area"],
    locations: ["Austin", "Round Rock", "Cedar Park", "Pflugerville", "Georgetown"],
  },
  {
    names: [
      "dallas",
      "dfw",
      "dallas fort worth",
      "dallas tx",
      "dallas texas",
      "fort worth",
      "dallas area",
    ],
    locations: [
      "Dallas",
      "Plano",
      "Irving",
      "Frisco",
      "Richardson",
      "Fort Worth",
      "Addison",
      "Arlington, TX",
      "DFW",
      "McKinney",
      "Allen, TX",
      "Carrollton",
      "Coppell",
      "Lewisville",
      "Southlake",
      "Grapevine",
    ],
  },
  {
    names: ["houston", "houston tx", "houston texas", "houston area"],
    locations: ["Houston", "Katy", "Sugar Land", "The Woodlands", "Pearland", "Humble"],
  },
  { names: ["texas", "tx"], locations: ["Texas", "TX"] },
  {
    names: ["los angeles", "la", "la area", "greater los angeles", "los angeles area"],
    locations: LOS_ANGELES_METRO,
  },
  { names: ["california", "ca", "calif"], locations: ["California", "CA"] },
  {
    names: ["boston", "boston ma", "boston area", "greater boston"],
    locations: [
      "Boston",
      "Cambridge, MA",
      "Somerville",
      "Waltham",
      "Burlington, MA",
      "Lexington, MA",
      "Woburn",
      "Quincy",
      "Watertown",
      "Needham",
      "Newton",
      "Bedford, MA",
      "Framingham",
      "Marlborough",
      "Westborough",
    ],
  },
  {
    names: ["chicago", "chicago il", "chicago area"],
    locations: [
      "Chicago",
      "Evanston",
      "Naperville",
      "Schaumburg",
      "Oak Brook",
      "Oakbrook",
      "Rosemont",
      "Lisle",
      "Deerfield",
      "Downers Grove",
      "Itasca",
      "Lombard",
    ],
  },
  {
    names: ["denver", "denver co", "denver area", "denver metro"],
    locations: [
      "Denver",
      "Englewood, CO",
      "Lakewood, CO",
      "Greenwood Village",
      "Broomfield",
      "Boulder",
    ],
  },
  {
    names: ["atlanta", "atlanta ga", "atlanta area"],
    locations: [
      "Atlanta",
      "Alpharetta",
      "Marietta",
      "Sandy Springs",
      "Roswell",
      "Decatur",
      "Smyrna",
      "Duluth",
      "Norcross",
      "Kennesaw",
    ],
  },
  {
    names: ["toronto", "gta", "greater toronto area"],
    locations: [
      "Toronto",
      "Mississauga",
      "Markham",
      "Brampton",
      "Vaughan",
      "Richmond Hill",
      "Oakville",
      "GTA",
    ],
  },
  { names: ["vancouver", "vancouver bc"], locations: ["Vancouver", "Burnaby", "Surrey"] },
  { names: ["london", "greater london", "london uk"], locations: ["London", "Greater London"] },
  { names: ["dublin", "dublin ireland"], locations: ["Dublin"] },
  { names: ["berlin", "berlin germany"], locations: ["Berlin"] },
  {
    names: ["bengaluru", "bangalore", "blr", "bengaluru india"],
    locations: ["Bengaluru", "Bangalore", "Karnataka", "Whitefield", "Bengalore", "BLR"],
  },
  {
    names: ["hyderabad", "hyderabad india", "hyderabad telangana"],
    locations: ["Hyderabad", "Secunderabad", "Telangana", "Hitec City", "Gachibowli", "Madhapur"],
  },
  { names: ["pune"], locations: ["Pune", "Pimpri", "Hinjewadi", "Kharadi"] },
  {
    names: ["mumbai", "bombay", "navi mumbai"],
    locations: ["Mumbai", "Navi Mumbai", "Bombay", "Powai", "Andheri"],
  },
  {
    names: ["delhi", "new delhi", "delhi ncr", "ncr", "gurgaon", "gurugram", "noida", "delhi area"],
    locations: [
      "Delhi",
      "New Delhi",
      "NCR",
      "Gurgaon",
      "Gurugram",
      "Noida",
      "Faridabad",
      "Ghaziabad",
    ],
  },
  { names: ["chennai", "madras"], locations: ["Chennai", "Madras"] },
  { names: ["singapore"], locations: ["Singapore"] },
  { names: ["sydney"], locations: ["Sydney"] },
  {
    names: [
      "remote",
      "anywhere",
      "work from home",
      "wfh",
      "home based",
      "distributed",
      "telecommute",
    ],
    locations: [],
    remote: true,
  },
];

/** Lowercase, every run of non-letters and digits as one space. */
const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const byName = new Map<string, Place>();
for (const place of PLACES) {
  for (const name of place.names) {
    // A name that two places claim would silently send one place's search to the other: refuse to load.
    if (byName.has(name)) throw new Error(`Place name "${name}" is listed twice`);
    byName.set(name, place);
  }
}

/** Where a person's place words point: whether to include remote work, and the location strings to match. */
export interface ExpandedPlaces {
  remote: boolean;
  /** Strings for the location text; each must match all of its words. Words the table does not know pass through. */
  locations: string[];
}

/**
 * Expands the place words a person (or the assistant, passing their words) gave. Known aliases become the strings
 * postings use; unknown words stay as written. Duplicates are dropped; order is kept.
 */
export function expandPlaces(words: string[]): ExpandedPlaces {
  let remote = false;
  const locations = new Set<string>();
  for (const word of words) {
    const key = normalize(word);
    if (!key) continue;
    const place = byName.get(key);
    if (!place) {
      locations.add(word.trim());
    } else if (place.remote) {
      remote = true;
    } else {
      for (const location of place.locations) locations.add(location);
    }
  }
  return { remote, locations: [...locations] };
}
