import type { JobLocation } from "@tallo/contracts";
import { usFlag } from "./location.ts";

/** Bump when the rules change; the catalog can then re-classify retained raw records. */
export const CLASSIFIER_VERSION = 1;

const TECH_TITLE = new RegExp(
  [
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
    "mobile engineer",
    "platform engineer",
    "infrastructure",
    "\\bcloud\\b",
    "\\bsdet\\b",
    "\\bqa (engineer|analyst)",
    "quality engineer",
    "test engineer",
    "automation engineer",
    "embedded",
    "firmware",
    "kubernetes",
    "\\bweb\\b",
    "cyber",
    "security (engineer|analyst|architect|researcher)",
    "network engineer",
    "systems? (engineer|administrator|architect|analyst)",
    "solutions? (engineer|architect)",
    "sales engineer",
    "forward deployed",
    "technical (program|product|account|support|writer)",
    "developer (advocate|relations)",
    "support engineer",
    "product (manager|designer|design)",
    "ux|ui (designer|design|researcher)",
    "\\bux\\b",
    "engineering manager",
    "research (scientist|engineer)",
    "computer vision",
    "\\bnlp\\b",
    "blockchain",
    "database",
    "\\bdba\\b",
    "\\bit (support|analyst|manager|specialist|administrator)",
    "technology (analyst|consultant|manager)",
    "\\bsap\\b",
    "salesforce (developer|admin)",
    "robotics",
    "hardware engineer",
    "\\bfpga\\b",
    "\\basic\\b",
    "\\brtl\\b",
    "gameplay",
    "game (developer|engineer)",
    "graphics",
    "compiler",
    "distributed systems",
    "staff engineer",
    "principal engineer",
    "member of technical staff",
    "mts\\b",
  ].join("|"),
  "i",
);

const TECH_DEPT =
  /\b(engineering|technology|software|data|product|design|information technology|\bit\b|security|infrastructure|platform|research|ai|machine learning|r&d|development)\b/i;

const NON_TECH_TITLE = new RegExp(
  [
    "\\b(nurse|rn|lpn|cna|physician|pharmacist|pharmacy|therapist|dental|dentist|veterinar|caregiver|phlebotom|paramedic|clinician)",
    "\\b(cashier|barista|cook|chef|server|bartender|host(ess)?|dishwasher|busser|baker|butcher)",
    "\\b(driver|warehouse|forklift|janitor|custodian|housekeep|groundskeeper|stocker|picker|packer|loader|courier)",
    "\\b(teacher|tutor|professor|instructor|paralegal|attorney|counsel|accountant|bookkeeper|auditor|underwriter|loan officer|teller)",
    "\\b(recruiter|talent acquisition|hr (business|generalist)|payroll|copywriter|merchandis|store manager|retail)",
    "\\b(account executive|sales (representative|associate|manager|director)|business development rep|sdr|bdr)\\b",
    "\\b(mechanic|welder|electrician|plumber|machinist|assembler|hvac|carpenter|technician(?! .*(it|software|network)))",
    "\\b(mechanical|civil|chemical|structural|process|manufacturing|industrial) engineer",
    "\\b(claims|adjuster|case manager|social worker|counselor|patient)",
  ].join("|"),
  "i",
);

const NON_TECH_DEPT =
  /\b(sales|marketing|finance|accounting|legal|people|human resources|\bhr\b|clinical|manufacturing|retail|supply chain|facilities|operations|customer (success|support|service)|food|hospitality|healthcare|nursing|logistics|real estate|procurement|communications|public relations|administrative)\b/i;

export interface Classification {
  isUs: 0 | 1 | null;
  isTech: 0 | 1 | null;
  version: number;
}

/** Public, versioned heuristics. NULL means "unknown", and unknown stays visible. */
export function classify(input: {
  title: string;
  department?: string;
  team?: string;
  locations: JobLocation[];
}): Classification {
  const dept = [input.department, input.team].filter(Boolean).join(" ");
  const techTitle = TECH_TITLE.test(input.title);
  const hard = NON_TECH_TITLE.test(input.title);
  let isTech: 0 | 1 | null = null;
  if (techTitle && !hard) isTech = 1;
  else if (dept && TECH_DEPT.test(dept) && !hard && !NON_TECH_DEPT.test(dept)) isTech = 1;
  else if (hard && !techTitle) isTech = 0;
  else if (dept && NON_TECH_DEPT.test(dept) && !techTitle) isTech = 0;
  return { isUs: usFlag(input.locations), isTech, version: CLASSIFIER_VERSION };
}
