import type { JobLocation } from "@tallo/contracts";
import { usFlag } from "./location.ts";

/** Bump when the rules change, then run `tallo reclassify` (no refetching needed). */
export const CLASSIFIER_VERSION = 2;

const re = (words: string[]) => new RegExp(words.join("|"), "i");

/** Titles that are tech on their own. */
const STRONG_TITLE = re([
  "software",
  "developer",
  "programmer",
  "devops",
  "\\bsre\\b",
  "site reliability",
  "machine learning",
  "\\bml\\b",
  "\\bai\\b",
  "artificial intelligence",
  "data (scientist|engineer|analyst|architect|platform)",
  "analytics engineer",
  "full.?stack",
  "front.?end",
  "back.?end",
  "\\bandroid\\b",
  "\\bios\\b",
  "mobile (engineer|developer)",
  "platform engineer",
  "infrastructure engineer",
  "\\bcloud\\b",
  "\\bsdet\\b",
  "embedded",
  "firmware",
  "kubernetes",
  "\\bweb (developer|engineer)",
  "cyber",
  "security (engineer|analyst|architect|researcher)",
  "network engineer",
  "systems? (administrator|architect|analyst)",
  "solutions? (engineer|architect)",
  "sales engineer",
  "forward deployed",
  "technical (program|product|account|support|writer)",
  "developer (advocate|relations)",
  "support engineer",
  "product (manager|designer|design)",
  "\\b(ux|ui)\\b",
  "research (scientist|engineer)",
  "computer vision",
  "\\bnlp\\b",
  "blockchain",
  "database",
  "\\bdba\\b",
  "technology (analyst|consultant|manager)",
  "salesforce (developer|admin)",
  "robotics",
  "hardware engineer",
  "\\bfpga\\b",
  "\\basic\\b",
  "\\brtl\\b",
  "game (developer|engineer)",
  "graphics (engineer|programmer)",
  "compiler",
  "distributed systems",
  "member of technical staff",
  "\\bmts\\b",
  "(staff|principal) (engineer|scientist)",
  "quantitative (developer|researcher)",
  "site engineer",
]);

/** The standalone word IT (case-sensitive, so "it" in prose is not matched). */
const IT_WORD = /\bIT\b/;

/** Titles that are tech only when the department or team says so. */
const WEAK_TITLE = re([
  "engineer",
  "architect",
  "analyst",
  "scientist",
  "researcher",
  "designer",
  "test",
  "quality",
  "automation",
]);

const TECH_DEPT = re([
  "engineering",
  "technology",
  "software",
  "\\bdata\\b",
  "product (management|design)?",
  "\\bdesign\\b",
  "information technology",
  "\\bit\\b",
  "security",
  "infrastructure",
  "platform",
  "\\bai\\b",
  "machine learning",
  "r&d",
]);

const NON_TECH_TITLE = re([
  "\\b(nurse|rn|lpn|cna|physician|pharmacist|pharmacy|therapist|dental|dentist|veterinar|caregiver|phlebotom|paramedic|clinician|behavior (technician|analyst)|pathologist|health aide)",
  "\\b(cashier|barista|cook|chef|server|bartender|host(ess)?|dishwasher|busser|baker|butcher|housekeep|janitor|custodian)",
  "\\b(driver|warehouse|forklift|groundskeeper|stocker|picker|packer|loader|courier|assembler|operator|laborer)",
  "\\b(teacher|tutor|professor|instructor|paralegal|attorney|counsel|accountant|bookkeeper|auditor|underwriter|loan officer|teller|banker)",
  "\\b(recruiter|talent acquisition|hr (business|generalist)|payroll|copywriter|merchandis|store manager|retail|junk)",
  "\\b(account executive|sales (representative|associate|manager|director|trainee)|business development rep|sdr|bdr)\\b",
  "\\b(mechanic|welder|electrician|plumber|machinist|hvac|carpenter|maintenance|technician)\\b",
  "\\b(mechanical|civil|chemical|structural|process|manufacturing|industrial|building|stationary|field service|resident|chief|facilit\\w*) engineer(ing)?",
  "\\b(claims|adjuster|case manager|social worker|counselor|patient)",
]);

const NON_TECH_DEPT = re([
  "\\bsales\\b",
  "marketing",
  "finance",
  "accounting",
  "legal",
  "\\bpeople\\b",
  "human resources",
  "\\bhr\\b",
  "clinical",
  "manufacturing",
  "retail",
  "supply chain",
  "facilities",
  "customer (success|support|service)",
  "food",
  "hospitality",
  "healthcare",
  "nursing",
  "logistics",
  "real estate",
  "procurement",
  "communications",
  "public relations",
  "administrative",
  "business development",
  "production",
  "therap",
  "home health",
]);

export interface Classification {
  isUs: 0 | 1 | null;
  isTech: 0 | 1 | null;
  version: number;
}

/**
 * Public, versioned heuristics; NULL means unknown, and unknown stays visible.
 * 1: a clearly tech title, or a generic engineering-ish title inside a tech department.
 * 0: a clearly non-tech title or department with no tech signal. Only zeros hide a job.
 */
export function classify(input: {
  title: string;
  department?: string;
  team?: string;
  locations: JobLocation[];
}): Classification {
  const { title } = input;
  const dept = [input.department, input.team].filter(Boolean).join(" ");
  const strong = STRONG_TITLE.test(title) || IT_WORD.test(title);
  const hardNo = NON_TECH_TITLE.test(title);
  const deptNo = NON_TECH_DEPT.test(dept);
  const deptYes = TECH_DEPT.test(dept);

  let isTech: 0 | 1 | null = null;
  if (strong && !hardNo) isTech = 1;
  else if (hardNo && !strong) isTech = 0;
  else if (
    !strong &&
    !hardNo &&
    deptYes &&
    !deptNo &&
    !NON_TECH_TITLE.test(dept) &&
    WEAK_TITLE.test(title)
  )
    isTech = 1;
  else if (!strong && (deptNo || NON_TECH_TITLE.test(dept))) isTech = 0;
  return { isUs: usFlag(input.locations), isTech, version: CLASSIFIER_VERSION };
}
